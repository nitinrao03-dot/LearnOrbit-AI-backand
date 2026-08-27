const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "LearnOrbit AI backend is running!"
    });
});

app.post("/api/ai-tutor", async (req, res) => {

    try {

        const { question, subject } = req.body;

        if (!question) {
            return res.status(400).json({
                success: false,
                message: "Question is required."
            });
        }

        const answer =
            `Demo response for ${subject || "General"}: ` +
            `Your question was: "${question}". ` +
            `The real AI response will be connected later.`;

        res.json({
            success: true,
            answer: answer
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            message: "Server error."
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`LearnOrbit AI backend running on port ${PORT}`);
});
