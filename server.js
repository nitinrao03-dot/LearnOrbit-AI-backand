// ============================================================
// LearnOrbit AI — Backend Server
// ------------------------------------------------------------
// This server keeps your Gemini API key hidden from users,
// handles login (email + password, no billing needed), and
// stores each user's progress in MongoDB so it syncs across
// every device they log in on.
// ============================================================

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

app.use(cors());
app.use(express.json());

const GEMINI_API_KEY =AQ.Ab8RN6I68e2IzZU4qmtCOggovmScXmOES4dNreO7PXbiyPL6ZQ
const GEMINI_MODEL = "gemini-2.5-flash";
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

mongoose.connect(MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => console.error("MongoDB connection error:", err));

// ------------------------------------------------------------
// Schemas
// ------------------------------------------------------------

const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String }, // no longer required — OTP accounts don't set a password
    otpCodeHash: String,
    otpExpires: Date,
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

const progressSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    topicsStudied: [{ question: String, date: { type: Date, default: Date.now } }],
    quizzes: [{ score: Number, total: Number, date: { type: Date, default: Date.now } }],
    flashcardsReviewed: { type: Number, default: 0 },
    plannerTasksCompleted: { type: Number, default: 0 }
});

const Progress = mongoose.model("Progress", progressSchema);

// ------------------------------------------------------------
// Auth helpers
// ------------------------------------------------------------

function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
        return res.status(401).json({ success: false, message: "Not logged in." });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: "Session expired, please log in again." });
    }
}

async function getOrCreateProgress(userId) {
    let progress = await Progress.findOne({ userId });
    if (!progress) {
        progress = await Progress.create({ userId });
    }
    return progress;
}

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------

app.get("/", (req, res) => {
    res.send("LearnOrbit AI backend is running.");
});

// ------------------------------------------------------------
// Email OTP helpers
// ------------------------------------------------------------

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}

async function sendOtpEmail(email, otp) {

    if (!RESEND_API_KEY) {
        throw new Error("Server is missing RESEND_API_KEY.");
    }

    const result = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + RESEND_API_KEY
        },
        body: JSON.stringify({
            from: "LearnOrbit AI <onboarding@resend.dev>", // works without owning a domain, for testing
            to: [email],
            subject: "Your LearnOrbit AI login code",
            html:
                "<p>Your LearnOrbit AI verification code is:</p>" +
                "<h2 style='letter-spacing:4px;'>" + otp + "</h2>" +
                "<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>"
        })
    });

    const data = await result.json();

    if (!result.ok) {
        throw new Error(data.message || "Could not send OTP email.");
    }
}

// ------------------------------------------------------------
// Auth routes — passwordless, email OTP
// ------------------------------------------------------------

// Step 1: request a code. Creates the account on first use (name optional).
app.post("/api/auth/send-otp", async (req, res) => {

    try {
        const { email, name } = req.body;

        if (!email || !email.trim()) {
            return res.status(400).json({ success: false, message: "Email is required." });
        }

        const cleanEmail = email.toLowerCase().trim();

        let user = await User.findOne({ email: cleanEmail });

        if (!user) {
            user = await User.create({ name: name || "", email: cleanEmail });
        } else if (name && !user.name) {
            user.name = name;
        }

        const otp = generateOtp();
        user.otpCodeHash = await bcrypt.hash(otp, 10);
        user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await user.save();

        await sendOtpEmail(cleanEmail, otp);

        res.json({ success: true, message: "OTP sent to your email." });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || "Could not send OTP." });
    }
});

// Step 2: verify the code and log in
app.post("/api/auth/verify-otp", async (req, res) => {

    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, message: "Email and OTP are required." });
        }

        const cleanEmail = email.toLowerCase().trim();

        const user = await User.findOne({ email: cleanEmail });

        if (!user || !user.otpCodeHash || !user.otpExpires) {
            return res.status(400).json({ success: false, message: "No OTP was requested for this email." });
        }

        if (user.otpExpires < new Date()) {
            return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
        }

        const valid = await bcrypt.compare(otp, user.otpCodeHash);
        if (!valid) {
            return res.status(400).json({ success: false, message: "Incorrect OTP." });
        }

        // OTP used — clear it so it can't be reused
        user.otpCodeHash = undefined;
        user.otpExpires = undefined;
        await user.save();

        const token = generateToken(user._id);

        res.json({ success: true, token, name: user.name, email: user.email });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Something went wrong." });
    }
});

// ------------------------------------------------------------
// Ask AI (now also records a "topic studied" entry)
// ------------------------------------------------------------

app.post("/api/ask", requireAuth, async (req, res) => {

    try {

        const { question, subject } = req.body;

        if (!question || !question.trim()) {
            return res.status(400).json({ success: false, message: "Question is required." });
        }

        if (!GEMINI_API_KEY) {
            return res.status(500).json({ success: false, message: "Server is missing GEMINI_API_KEY." });
        }

        const systemPrompt =
            "You are LearnOrbit AI, an expert tutor" +
            (subject ? " for the subject: " + subject : "") +
            ". Explain concepts clearly for a student: start with a one-line simple definition, " +
            "then explain in more depth with short paragraphs or bullet points, " +
            "use a real-world example where useful, avoid unnecessary jargon, " +
            "and keep the tone encouraging. If unsure, say so honestly.";

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ role: "user", parts: [{ text: question }] }],
                    generationConfig: { temperature: 0.4 }
                })
            }
        );

        const data = await geminiResponse.json();

        if (!geminiResponse.ok) {
            throw new Error(data.error?.message || "Gemini API error.");
        }

        const answer =
            data.candidates?.[0]?.content?.parts?.[0]?.text ||
            "Sorry, I couldn't generate an answer. Please try again.";

        // Record this as a studied topic
        const progress = await getOrCreateProgress(req.userId);
        progress.topicsStudied.push({ question });
        await progress.save();

        res.json({ success: true, answer });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || "Something went wrong." });
    }

});

// ------------------------------------------------------------
// Progress routes
// ------------------------------------------------------------

// Record a completed quiz
app.post("/api/progress/quiz", requireAuth, async (req, res) => {
    try {
        const { score, total } = req.body;
        const progress = await getOrCreateProgress(req.userId);
        progress.quizzes.push({ score, total });
        await progress.save();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Something went wrong." });
    }
});

// Record a flashcard reviewed
app.post("/api/progress/flashcard", requireAuth, async (req, res) => {
    try {
        const progress = await getOrCreateProgress(req.userId);
        progress.flashcardsReviewed += 1;
        await progress.save();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Something went wrong." });
    }
});

// Record a completed planner task
app.post("/api/progress/task", requireAuth, async (req, res) => {
    try {
        const progress = await getOrCreateProgress(req.userId);
        progress.plannerTasksCompleted += 1;
        await progress.save();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Something went wrong." });
    }
});

// Get a summary for the dashboard
app.get("/api/progress/summary", requireAuth, async (req, res) => {
    try {
        const progress = await getOrCreateProgress(req.userId);

        const topicsStudied = progress.topicsStudied.length;
        const quizzesCompleted = progress.quizzes.length;

        // Simple overall progress score out of 100, combining the three activities.
        // Feel free to adjust the weights/caps to fit how your app should feel.
        const studyProgress = Math.min(
            100,
            Math.round(
                (topicsStudied * 2) +
                (quizzesCompleted * 5) +
                (progress.flashcardsReviewed * 1) +
                (progress.plannerTasksCompleted * 3)
            )
        );

        res.json({
            success: true,
            topicsStudied,
            quizzesCompleted,
            flashcardsReviewed: progress.flashcardsReviewed,
            plannerTasksCompleted: progress.plannerTasksCompleted,
            studyProgress,
            recentTopics: progress.topicsStudied.slice(-5).reverse(),
            recentQuizzes: progress.quizzes.slice(-5).reverse()
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Something went wrong." });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`LearnOrbit AI backend running on port ${PORT}`);
});
