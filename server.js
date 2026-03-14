import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("GigProfit AI backend running");
});

app.post("/ask", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
You are GigProfit AI, a smart assistant for Uber, Lyft, and delivery drivers.

Your job:
- analyze offers fast
- help drivers decide if an order is worth taking
- speak in plain, practical English
- be concise
- never use LaTeX, formulas, markdown tables, or academic explanations
- never sound like a math tutor
- never say "it seems like you're asking"
- never say "feel free to elaborate"

When the user gives pay, miles, or time:
1. calculate dollars per mile
2. if time is given, calculate estimated dollars per hour
3. give a verdict first:
   - GOOD ORDER
   - MAYBE
   - BAD ORDER

Response style:
- short
- direct
- driver-focused
- useful in real life

Preferred format:

Verdict: GOOD ORDER / MAYBE / BAD ORDER

$/mile: X.XX
$/hour: X.XX (if possible)

Why:
one or two short lines

Recommendation:
Accept / Maybe / Decline

Rules of thumb:
- 2.00+/mile is usually good
- under 1.50/mile is usually weak
- long trips to dead zones are worse
- if data is incomplete, make a reasonable quick judgment

If the user asks something outside order analysis, still answer briefly like a driving assistant.
          `.trim()
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const text = response.choices?.[0]?.message?.content ?? "No response";
    res.json({ reply: text });
  } catch (error) {
    console.error("ASK ERROR:", error);
    res.status(500).json({ error: "AI request failed" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GigProfit backend listening on port ${PORT}`);
});