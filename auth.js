/* =========================================================
   auth.js — accounts for CivicConnect

   Sign in, create account, email verification and password reset, using
   Supabase Auth from the browser. This file only decides what the person SEES.
   The server checks every token itself (authenticate() in server.js), so nothing
   here is a security boundary: hiding a button is a convenience, not protection.

   Load order (see index.html): /vendor/supabase.js, then this file, then app.js.
   app.js talks to this file through the global `Auth` object.
========================================================= */

window.Auth = (function () {
  'use strict';

  const MIN_PASSWORD_LENGTH = 8;            // shown on the form; Supabase enforces its own minimum as well
  const RESEND_COOLDOWN_MS = 60 * 1000;     // Supabase sends at most one confirmation email per address per minute
  const TOKEN_SAFETY_MARGIN_MS = 30 * 1000; // a token expiring within 30 s is refreshed instead of being sent

  let client = null;      // Supabase browser client; stays null when sign-in is not configured on the server
  let session = null;     // latest Supabase session, or null when signed out
  let mode = 'signin';    // which form the auth view shows: signin | signup | forgot | recovery | verify
  let pendingEmail = '';  // address a verification email was just sent to
  let ready = false;      // false until init() knows whether sign-in is available; nothing is painted before that
  let coolingEmail = null; // address whose "resend" is cooling down (Supabase limits resends per address)
  let resendTimer = null;
  let signOutReason = null;            // 'expired' when the server rejected our token, so the toast can say why
  let cameFromVerificationLink = false; // the page was opened from the emailed "confirm your email" link

  // True while we expect a SIGNED_IN event that the person just caused (form sign-in,
  // verification link), so it gets a welcome message. The library ALSO fires SIGNED_IN
  // when it restores a stored session on every page load, and at unpredictable times
  // relative to our start-up; that must stay silent, so "was I signed in before?" is
  // not a reliable test and an explicit flag is used instead.
  let announceSignIn = false;

  // app.js supplies these so this file never has to know how views are switched.
  let hooks = { openAuthView() {}, closeAuthView() {}, toast() {} };
  const listeners = [];

  const $ = (id) => document.getElementById(id);
  const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);


  /* ---------------- What each form says ----------------
     Copy is written from the visitor's side of the screen: what they can do and
     what happens next. */
  const MODES = {
    signin: {
      title: 'Sign in',
      desc: 'Sign in to report issues and confirm existing ones. You can browse reports and analytics without an account.',
      submit: 'Sign in',
      email: true, password: true,
      passwordLabel: 'Password', passwordAutocomplete: 'current-password',
      showSignup: true, showForgot: true, signinLabel: null
    },
    signup: {
      title: 'Create account',
      desc: 'Use an email address you can open. We send a verification link, and you can report issues once it is verified.',
      submit: 'Create account',
      email: true, password: true,
      passwordLabel: `Password (at least ${MIN_PASSWORD_LENGTH} characters)`, passwordAutocomplete: 'new-password',
      showSignup: false, showForgot: false, signinLabel: 'I already have an account'
    },
    forgot: {
      title: 'Reset password',
      desc: 'Enter your account email. We will send a link for choosing a new password.',
      submit: 'Send reset link',
      email: true, password: false,
      showSignup: false, showForgot: false, signinLabel: 'Back to sign in'
    },
    recovery: {
      title: 'Choose a new password',
      desc: 'Enter a new password for your account.',
      submit: 'Save new password',
      email: false, password: true,
      passwordLabel: `New password (at least ${MIN_PASSWORD_LENGTH} characters)`, passwordAutocomplete: 'new-password',
      showSignup: false, showForgot: false, signinLabel: null
    }
  };


  /* ---------------- Who is signed in ---------------- */

  function user() { return session ? session.user : null; }
  function isSignedIn() { return Boolean(session); }

  // Supabase sets email_confirmed_at only after the emailed link was opened.
  function isVerified() { const u = user(); return Boolean(u && u.email_confirmed_at); }

  // Roles live in app_metadata, which only the project owner can edit (unlike
  // user_metadata, which users can change themselves). The server re-checks this.
  function isAuthority() {
    const u = user();
    return Boolean(u && isVerified() && u.app_metadata && u.app_metadata.role === 'authority');
  }

  // The access token to send with API calls. The cached session is used while it
  // has time left, because asking the library on every request is needlessly
  // chatty; when it is nearly expired the library refreshes it for us.
  async function getAccessToken() {
    if (!client) return null;

    if (session && session.expires_at * 1000 - Date.now() > TOKEN_SAFETY_MARGIN_MS) {
      return session.access_token;
    }

    const { data } = await client.auth.getSession();
    session = data.session;
    return session ? session.access_token : null;
  }


  /* ---------------- Start-up ---------------- */

  async function init(passedHooks) {
    hooks = { ...hooks, ...(passedHooks || {}) };

    wireDom();
    noteLinkOutcome(); // must run before the library rewrites the URL

    // The browser learns the project URL and publishable key from the server, so
    // they live in one place (the server's environment) instead of in this file.
    let config = {};
    try { config = await (await fetch('/api/config')).json(); } catch { /* handled below */ }

    if (!window.supabase || !config.supabaseUrl || !config.supabasePublishableKey) {
      console.error(
        'Sign-in is unavailable: ' +
        (!window.supabase ? 'the Supabase browser bundle did not load (/vendor/supabase.js).'
                          : 'the server has no SUPABASE_PUBLISHABLE_KEY (see README, "Accounts and sign-in").')
      );
      ready = true;
      render();
      return;
    }

    client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
    client.auth.onAuthStateChange(handleAuthEvent);

    // Waits until a session carried by an emailed link (in the URL) has been processed.
    const { data } = await client.auth.getSession();
    session = data.session;
    ready = true;
    render();
  }

  // Emailed links return here with the outcome in the URL fragment: either a new
  // session (...&type=signup) or an error (#error_description=...). Read it now,
  // before the library consumes it.
  function noteLinkOutcome() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const type = params.get('type');
    const problem = params.get('error_description');

    cameFromVerificationLink = type === 'signup' || type === 'email';
    announceSignIn = cameFromVerificationLink;

    if (problem) {
      setMode('signin');
      say(`${problem.replace(/[.\s]+$/, '')}. Sign in to request a new verification link.`, 'error');
      hooks.openAuthView();
      // Error fragments are not cleaned up by the library, and would re-show on refresh.
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  function handleAuthEvent(event, newSession) {
    const wasSignedIn = Boolean(session);
    session = newSession;

    // The reset link signs the person in, but they must choose a password first.
    if (event === 'PASSWORD_RECOVERY') {
      setMode('recovery');
      hooks.openAuthView();
    }

    // Deferred on purpose: the library calls this while holding an internal lock,
    // and calling back into the library from inside it can deadlock. Our own
    // listeners fetch data, so they run just after.
    setTimeout(() => {
      render();

      if (announceSignIn && newSession && event === 'SIGNED_IN' && mode !== 'recovery') {
        announceSignIn = false;
        hooks.closeAuthView();
        hooks.toast(cameFromVerificationLink
          ? `Email verified. You're signed in as ${newSession.user.email}.`
          : `Signed in as ${newSession.user.email}.`);
        cameFromVerificationLink = false;
      }

      if (wasSignedIn && !newSession && event === 'SIGNED_OUT') {
        hooks.toast(signOutReason === 'expired'
          ? 'Your session has expired. Please sign in again.'
          : 'Signed out.');
        signOutReason = null;
      }

      listeners.forEach((callback) => callback(event, session));
    }, 0);
  }


  /* ---------------- Actions ---------------- */

  function wireDom() {
    $('authForm').addEventListener('submit', onSubmit);

    // One delegated listener serves every sign-in control on the page (header,
    // report gate, auth view) through its data-auth attribute.
    document.addEventListener('click', (event) => {
      const control = event.target.closest('[data-auth]');
      if (control) onAction(control.dataset.auth);
    });
  }

  function onAction(action) {
    switch (action) {
      case 'signin':    openSignIn('signin'); break;
      case 'to-signup': setMode('signup'); break;
      case 'to-signin': setMode('signin'); break;
      case 'to-forgot': setMode('forgot'); break;
      case 'resend':    resendVerification(); break;
      case 'signout':   signOut(); break;
      case 'done':      hooks.closeAuthView(); break;
    }
  }

  function openSignIn(nextMode) {
    setMode(nextMode || 'signin');
    hooks.openAuthView();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!client) return;

    say('', '');
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;

    $('authSubmit').disabled = true; // stop double submits while Supabase answers
    try {
      if (mode === 'signin') await signIn(email, password);
      else if (mode === 'signup') await signUp(email, password);
      else if (mode === 'forgot') await requestReset(email);
      else if (mode === 'recovery') await saveNewPassword(password);
    } catch (error) {
      say(explain(error), 'error');
    } finally {
      $('authSubmit').disabled = false;
    }
  }

  async function signIn(email, password) {
    if (!email || !password) return say('Enter your email and password.', 'error');

    announceSignIn = true;
    const { error } = await client.auth.signInWithPassword({ email, password });

    if (error) {
      announceSignIn = false;
      // Signing in before opening the emailed link: send them to the verify step
      // (where they can request a new link) instead of a dead-end error.
      if (isUnverifiedError(error)) {
        pendingEmail = email;
        return setMode('verify');
      }
      return say(explain(error), 'error');
    }

    // Success: the SIGNED_IN event closes this view.
    $('authPassword').value = '';
  }

  async function signUp(email, password) {
    if (!isEmail(email)) return say('Enter a valid email address.', 'error');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return say(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`, 'error');
    }

    // emailRedirectTo sends the person back to whichever address they signed up
    // from. It must be listed under Authentication > URL Configuration in Supabase.
    announceSignIn = true; // only matters if email confirmation is off and this returns a session
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin }
    });

    if (error || !data.session) announceSignIn = false;
    if (error) return say(explain(error), 'error');

    // For an address that already has an account, Supabase answers "success" with
    // an empty identities list (so attackers can't discover who is registered).
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return say('An account with this email already exists. Sign in instead, or reset your password.', 'error');
    }

    $('authPassword').value = '';

    // A session here means email confirmation is switched off in Supabase. The
    // SIGNED_IN event handles that case; otherwise wait for the emailed link.
    if (!data.session) {
      pendingEmail = email;
      setMode('verify');
      startResendCooldown(email); // the first email was just sent
    }
  }

  async function requestReset(email) {
    if (!isEmail(email)) return say('Enter a valid email address.', 'error');

    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (error) return say(explain(error), 'error');

    // Same answer whether or not the address has an account, so it can't be probed.
    say('If that address has an account, a reset link is on its way. Open it on this device.', 'ok');
  }

  async function saveNewPassword(password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return say(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`, 'error');
    }

    const { error } = await client.auth.updateUser({ password });
    if (error) return say(explain(error), 'error');

    $('authPassword').value = '';
    setMode('signin');
    hooks.closeAuthView();
    hooks.toast('Password updated. You are signed in.');
  }

  async function resendVerification() {
    const email = pendingEmail || (user() && user().email);
    if (!client || !email || coolingEmail === email) return;

    const { error } = await client.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin }
    });

    if (error) return say(explain(error), 'error');

    say('Verification email sent. It can take a minute; check your spam folder too.', 'ok');
    startResendCooldown(email);
  }

  // Signs out of THIS browser only ('local'), not every device the person uses.
  async function signOut() {
    if (client) await client.auth.signOut({ scope: 'local' });
  }

  // Called by app.js when the server rejects our token (revoked or account
  // removed): drop the dead session so the page stops offering signed-in actions.
  async function expireSession() {
    if (!client || !session) return;
    signOutReason = 'expired';
    await client.auth.signOut({ scope: 'local' });
  }

  function startResendCooldown(email) {
    coolingEmail = email;
    clearTimeout(resendTimer);
    resendTimer = setTimeout(() => { coolingEmail = null; render(); }, RESEND_COOLDOWN_MS);
    render();
  }


  /* ---------------- Messages ---------------- */

  function isUnverifiedError(error) {
    return error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message || '');
  }

  // Turns a Supabase error into something the visitor can act on: say what went
  // wrong and what to do about it. Unknown errors fall back to Supabase's own text.
  function explain(error) {
    const code = error.code || '';
    const text = (error.message || '').toLowerCase();

    if (code === 'invalid_credentials' || text.includes('invalid login credentials')) {
      return 'Email or password is incorrect. Check both, or reset your password.';
    }
    if (code === 'email_address_invalid' || text.includes('validate email address') || /^email address .* is invalid/.test(text)) {
      return 'Enter a valid email address.';
    }
    if (code === 'weak_password') {
      return `Choose a stronger password: at least ${MIN_PASSWORD_LENGTH} characters, mixing letters and numbers.`;
    }
    if (code === 'user_already_exists' || code === 'email_exists') {
      return 'An account with this email already exists. Sign in instead, or reset your password.';
    }
    if (code === 'over_email_send_rate_limit') {
      return 'Too many emails requested. Wait a minute, then try again.';
    }
    if (code === 'over_request_rate_limit' || error.status === 429) {
      return 'Too many attempts. Wait a minute, then try again.';
    }
    if (code === 'email_address_not_authorized') {
      return "This site can't send email to that address yet. The site owner needs to set up custom email (SMTP) in Supabase.";
    }
    if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    }
    return error.message || 'Something went wrong. Please try again.';
  }

  function say(text, kind) {
    const box = $('authMsg');
    box.textContent = text;
    box.className = 'auth-msg' + (text && kind ? ' ' + kind : '');
  }


  /* ---------------- Rendering ---------------- */

  function setMode(next) {
    mode = next;
    say('', '');
    render();

    // Put the cursor where typing starts, so keyboard and screen-reader users
    // land in the form after switching panels.
    const first = !$('authEmailRow').hidden ? $('authEmail') : $('authPassword');
    if (!$('authForm').hidden) first.focus();
  }

  function render() {
    if (!ready) return;
    renderAccountArea();
    renderAuthView();
  }

  function actionButton(label, action, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.auth = action;
    button.textContent = label;
    return button;
  }

  // The sign-in / account chip in the page header.
  function renderAccountArea() {
    const area = $('accountArea');
    area.textContent = ''; // tiny, so rebuilt from scratch rather than patched

    if (!isSignedIn()) {
      area.appendChild(actionButton('Sign in', 'signin', 'btn-account'));
      return;
    }

    // textContent, never innerHTML: an email address is text typed by a user.
    const email = document.createElement('span');
    email.className = 'account-email';
    email.textContent = user().email || '';
    email.title = user().email || '';

    const role = document.createElement('span');
    role.className = 'role-chip' + (!isVerified() ? ' unverified' : isAuthority() ? ' authority' : '');
    role.textContent = !isVerified() ? 'Unverified' : isAuthority() ? 'Authority' : 'Citizen';

    area.append(email, role, actionButton('Sign out', 'signout', 'btn-account'));
  }

  // Exactly one panel of the auth view is visible at a time.
  function renderAuthView() {
    const needsVerification = isSignedIn() && !isVerified();

    let panel;
    if (!client) panel = 'unavailable';
    else if (mode === 'recovery') panel = 'form';   // signed in by the reset link, but must pick a password first
    else if (needsVerification || (!isSignedIn() && mode === 'verify')) panel = 'verify';
    else if (isSignedIn()) panel = 'signedin';
    else panel = 'form';

    $('authUnavailable').hidden = panel !== 'unavailable';
    $('authForm').hidden = panel !== 'form';
    $('authVerify').hidden = panel !== 'verify';
    $('authSignedIn').hidden = panel !== 'signedin';

    const copy = panel === 'form' ? MODES[mode]
      : panel === 'verify' ? { title: 'Verify your email', desc: 'One step left: confirm that this address is yours.' }
      : panel === 'signedin' ? { title: 'Your account', desc: '' }
      : { title: 'Sign in', desc: '' };
    $('authTitle').textContent = copy.title;
    $('authDesc').textContent = copy.desc;

    if (panel === 'form') {
      const m = MODES[mode];
      $('authEmailRow').hidden = !m.email;
      $('authPasswordRow').hidden = !m.password;
      if (m.password) {
        $('authPasswordLabel').textContent = m.passwordLabel;
        $('authPassword').setAttribute('autocomplete', m.passwordAutocomplete);
      }
      $('authSubmit').textContent = m.submit;
      $('linkSignup').hidden = !m.showSignup;
      $('linkForgot').hidden = !m.showForgot;
      $('linkSignin').hidden = !m.signinLabel;
      if (m.signinLabel) $('linkSignin').textContent = m.signinLabel;
    }

    if (panel === 'verify') {
      const address = pendingEmail || (user() && user().email) || '';
      $('verifyEmail').textContent = address;
      $('btnResend').disabled = coolingEmail === address; // avoids Supabase's one-email-per-minute limit
    }

    if (panel === 'signedin') {
      $('signedInEmail').textContent = user().email || '';
      $('signedInRole').textContent = isAuthority() ? 'authority' : 'citizen';
    }
  }


  /* ---------------- Public interface ---------------- */

  return {
    init,
    openSignIn,
    signOut,
    expireSession,
    getAccessToken,
    isSignedIn,
    isVerified,
    isAuthority,
    email: () => (user() ? user().email : null),
    userId: () => (user() ? user().id : null),
    isConfigured: () => client !== null,
    // Registers a callback(event, session) for sign-in, sign-out and token changes.
    onChange: (callback) => listeners.push(callback)
  };
})();
