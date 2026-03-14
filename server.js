import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


// TEST ROUTE
app.get("/", (req, res) => {
  res.send("GigProfit backend running 🚀");
});


// AI CHAT ENDPOINT
app.post("/ai/chat", async (req, res) => {
  try {

    const { message } = req.body;

    const prompt = `
You are GigProfit AI.

You help gig workers in the United States maximize profits while driving for apps like:
Uber
Lyft
Uber Eats
DoorDash
Instacart

Give practical advice about:

• best times to drive
• good vs bad orders
• strategies for maximizing profit
• avoiding low-paying trips
• driving demand patterns

Keep responses clear and helpful.

User question:
${message}
`;

    const response = await openai.responses.create({
      model: "gpt-5-mini",
      input: prompt
    });

    const reply = response.output_text;

    res.json({
      reply: reply
    });

  } catch (error) {

    console.error("OpenAI error:", error);

    res.status(500).json({
      reply: "AI temporarily unavailable."
    });

  }
});


// START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 GigProfit backend running on port ${PORT}`);
});