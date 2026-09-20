// ai.js — Gemini image analysis

const { GoogleGenerativeAI } = require("@google/generative-ai");

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable");
}

const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash"
});

async function analyzeIssueImage(imageBuffer, mimeType) {

    const imagePart = {
        inlineData: {
            data: imageBuffer.toString("base64"),
            mimeType: mimeType
        }
    };

    const prompt = `
You are an AI system used by CivicConnect, a civic issue reporting platform.

Analyze the uploaded image and determine whether it shows a genuine civic, public infrastructure, environmental, or municipal issue.

Use these predefined categories when they clearly match:

- Pothole
- Garbage / Waste
- Streetlight
- Water Leakage
- Damaged Road

If the issue does NOT clearly match one of the predefined categories, CREATE A NEW, SPECIFIC CATEGORY NAME based only on what is visible.

Examples of valid AI-generated categories:

- Open Manhole
- Broken Traffic Signal
- Fallen Tree
- Blocked Drain
- Damaged Public Bench
- Exposed Electrical Wiring

IMPORTANT RULES:

1. Never use "Other".
2. Never use "Other Civic Issue".
3. Never use "Unknown".
4. Do not force an issue into an unrelated predefined category.
5. A generated category must be short, specific, and descriptive.
6. Only describe information that can reasonably be determined from the image.
7. Do not invent details that are not visible.
8. If the image does not show a genuine civic issue, set "is_civic_issue" to false.
9. Non-civic images must be rejected by the application.
10. Do not create a category for a non-civic image.
11. Do not treat ordinary personal objects, people, animals, food, landscapes, vehicles, or unrelated photographs as civic issues unless they clearly show a civic/public problem.
12. If the image is ambiguous and there is insufficient visual evidence of a civic issue, set "is_civic_issue" to false.

Determine:

- whether it is a civic issue
- category
- severity
- confidence
- short description

Severity must be one of:

- Low
- Medium
- High
- Critical

Confidence must be one of:

- Low
- Medium
- High

For a genuine civic issue:
- "is_civic_issue" must be true.
- "category" must contain the most appropriate predefined or AI-generated category.
- "severity" must be Low, Medium, High, or Critical.
- "confidence" must be Low, Medium, or High.
- "description" must briefly describe the visible issue.

For a non-civic image:
- "is_civic_issue" must be false.
- "category" must be null.
- "severity" must be null.
- "confidence" must still indicate how confident the AI is that the image is not a civic issue.
- "description" must briefly explain why the image does not appear to show a civic issue.

Return ONLY valid JSON.

Do not include markdown.
Do not include code fences.
Do not include explanations outside the JSON.

For a civic issue, use this structure:

{
  "is_civic_issue": true,
  "category": "Pothole",
  "severity": "High",
  "confidence": "High",
  "description": "A large pothole is visible on the roadway."
}

For a non-civic image, use this structure:

{
  "is_civic_issue": false,
  "category": null,
  "severity": null,
  "confidence": "High",
  "description": "The image does not show a visible civic or public infrastructure issue."
}`;

    const result = await model.generateContent([
        prompt,
        imagePart
    ]);

    const text = result.response.text().trim();

    // Remove accidental markdown code fences
    const cleanedText = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    try {
        return JSON.parse(cleanedText);
    } catch (error) {
        console.error("Gemini returned invalid JSON:");
        console.error(text);

        throw new Error("Gemini returned invalid JSON");
    }
}

module.exports = {
    analyzeIssueImage
};