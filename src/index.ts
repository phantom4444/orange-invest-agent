// src/index.ts
import 'dotenv/config';
import readline from 'readline';
import { AgentOrchestrator } from './agent';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const agent = new AgentOrchestrator();

console.log("🤖 Errand Agent initialized! (Type 'exit' to quit)\n");
console.log("Agent: Hello! What errand can I help you book today?");
process.stdout.write("\nYou: ");

rl.on('line', async (line) => {
  const input = line.trim();
  if (input.toLowerCase() === 'exit') {
    rl.close();
    process.exit(0);
  }

  const response = await agent.handleMessage(input);
  console.log(`\nAgent: ${response}`);
  process.stdout.write("\nYou: ");
});