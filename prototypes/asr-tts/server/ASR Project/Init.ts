import 'dotenv/config';
import OpenAI from "openai";
const key = process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const models = await client.models.list();
console.log(models.data.length);
