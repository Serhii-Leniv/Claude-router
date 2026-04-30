import { createRouter } from '../src/index.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

const router = createRouter({
  apiKey,
  verbose: true,
});

async function main() {
  // Simple task → should route to haiku
  console.log('\n--- Simple task (expect haiku) ---');
  const simple = await router.send({
    messages: [{ role: 'user', content: 'Translate to French: Hello world' }],
    max_tokens: 100,
  });
  console.log('Response:', simple.content[0]?.type === 'text' ? simple.content[0].text : '');
  console.log('Tier:', simple.meta.tier);

  // Medium task → should route to sonnet
  console.log('\n--- Medium task (expect sonnet) ---');
  const medium = await router.send({
    messages: [{ role: 'user', content: 'Explain how database connection pooling works and compare different strategies' }],
    max_tokens: 500,
  });
  console.log('Response:', (medium.content[0] as { text: string }).text.slice(0, 100) + '...');
  console.log('Tier:', medium.meta.tier);

  // Complex task → should route to opus
  console.log('\n--- Complex task (expect opus) ---');
  const complex = await router.send({
    messages: [
      {
        role: 'user',
        content:
          'Design and architect a distributed event-driven microservices system for real-time financial trading. Evaluate tradeoffs between consistency and availability. Strategize about fault tolerance across multiple regions.',
      },
    ],
    max_tokens: 1000,
  });
  console.log('Response:', (complex.content[0] as { text: string }).text.slice(0, 100) + '...');
  console.log('Tier:', complex.meta.tier);

  // Forced tier
  console.log('\n--- Forced opus ---');
  const forced = await router.send({
    messages: [{ role: 'user', content: 'Say hi' }],
    max_tokens: 50,
    tier: 'opus',
  });
  console.log('Tier:', forced.meta.tier);

  // Session stats
  console.log('\n--- Session Stats ---');
  console.log(router.stats());
}

main().catch(console.error);
