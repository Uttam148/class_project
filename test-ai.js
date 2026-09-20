require("dotenv").config();

const fs = require("fs");
const { analyzeIssueImage } = require("./ai");

async function test() {
    try {
        const imagePath = process.argv[2];

        if (!imagePath) {
            console.log("Usage: node test-ai.js <image-path>");
            process.exit(1);
        }

        if (!fs.existsSync(imagePath)) {
            console.log("Image file not found:", imagePath);
            process.exit(1);
        }

        const imageBuffer = fs.readFileSync(imagePath);

        const mimeType =
            imagePath.toLowerCase().endsWith(".png")
                ? "image/png"
                : "image/jpeg";

        console.log("Analyzing image...");

        const result = await analyzeIssueImage(
            imageBuffer,
            mimeType
        );

        console.log("\nGemini result:");
        console.log(JSON.stringify(result, null, 2));

    } catch (error) {
        console.error("\nAI test failed:");
        console.error(error.message);
    }
}

test();