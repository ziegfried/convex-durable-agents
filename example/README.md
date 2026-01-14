# Durable Agents Example

This example demonstrates the Convex Durable Agents component with a chat interface.

## Features

- Thread-based conversations with AI
- Tool execution (weather lookup)
- Real-time streaming responses
- Status indicators and controls (stop, retry)
- Thread management (create, delete, list)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set up your Convex project:

```bash
npx convex dev
```

3. Configure your AI model:

Edit `convex/chat.ts` and replace the mock model with your actual AI model:

```ts
// Example with OpenAI:
import { openai } from "@ai-sdk/openai";
const model = openai("gpt-4o");

// Example with Anthropic:
import { anthropic } from "@ai-sdk/anthropic";
const model = anthropic("claude-sonnet-4-20250514");
```

4. Set your API keys in the Convex dashboard or `.env.local`:

```
OPENAI_API_KEY=your-key-here
# or
ANTHROPIC_API_KEY=your-key-here
```

5. Run the development server:

```bash
npm run dev
```

## Project Structure

```
example/
├── convex/
│   ├── chat.ts          # Agent definition and API
│   ├── tools/
│   │   └── weather.ts   # Tool implementations
│   ├── schema.ts        # App schema (empty - component manages tables)
│   └── convex.config.ts # Component registration
└── src/
    ├── App.tsx          # Chat UI
    └── main.tsx         # Entry point
```

## Usage

1. Click "New Chat" to start a conversation
2. Ask about the weather: "What's the weather in San Francisco?"
3. The agent will use the weather tool to fetch data
4. Watch the streaming response and tool execution status
5. Use Stop/Retry buttons to control the conversation

## Available Tools

- `get_weather` - Returns weather conditions and temperature for a city
- `get_temperature` - Async tool demonstrating delayed results

## Notes

- The weather tool returns mock data for demonstration
- In production, replace with actual API calls
- The component handles all durability concerns automatically
