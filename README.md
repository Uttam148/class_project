# CivicConnect

> Crowdsourced Civic Issue Reporting & Resolution System

Citizens report local civic problems (potholes, garbage, broken streetlights, water leaks) with a photo and their location. Reports are automatically classified, de-duplicated, prioritised, and sent to the right authority, who track each issue through to resolution. Built as an SIH 2026 MVP.

**Live demo:** [class-project-vi2a.onrender.com](https://class-project-vi2a.onrender.com)

## Features

- Report issues with a description, photo, and real device location (shown as a place name)
- AI-based classification of category and severity using Google Gemini
- Duplicate detection: similar open reports are merged as confirmations
- Community confirmations and automatic priority scoring
- Sign-up, sign-in, email verification, and password reset
- Role-based access: only authorities can update issue status
- Analytics dashboard

## Tech stack

Node.js, Express, Supabase (database and auth), Google Gemini, Multer, vanilla HTML/CSS/JS, hosted on Render.

## Getting started

```bash
git clone https://github.com/Uttam148/class_project.git
cd class_project
npm install
npm start
```

Then open <http://localhost:4000>. You'll need to add your Supabase and Gemini credentials in a `.env` file first.

## Project structure

```
server.js     Express server and API routes
db.js         Supabase connection and data access
ai.js         Gemini-based classification
logic.js      Duplicate detection and priority scoring
public/       Frontend
uploads/      Uploaded photos
```

