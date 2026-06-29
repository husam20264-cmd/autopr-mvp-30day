export default {
  port: parseInt(process.env.PORT || '3000'),
  logLevel: process.env.LOG_LEVEL || 'info',

  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  },

  llm: {
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    maxTokens: 2048,
    temperature: 0.1,
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    priceId: process.env.STRIPE_PRICE_ID,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  pricing: {
    freeMonthlyPRs: 5,
    paidMonthlyPrice: 1900, // $19 in cents
  },

  safety: {
    maxDiffLength: 3000,
    bannedPatterns: [
      /rm\s+-rf/,
      /process\.exit/,
      /DROP\s+TABLE/i,
      /DELETE\s+FROM/i,
      /exec\(/,
      /eval\(/,
      /child_process/,
      /fs\.unlinkSync/,
      /\.removeEventListener/,
    ],
  },

  limits: {
    maxPRsPerRepoPerDay: 3,
    maxPRsPerInstallPerDay: 20,
  },
};
