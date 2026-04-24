export const widgetConfig = {
  title: "Product Insights ✨",
  subtitle: "No research needed — get answers right away",
  inputPlaceholder: "Ask a question...",
  askButton: "Ask",
  faqHeader: "Frequently Asked Questions",
  loadingMessages: ["Retrieving...", "Analyzing...", "Answering..."],
  disclaimerLinkText:
    "Disclaimer: Click to read important information about use of this tool",
  disclaimerHeader: "Important Information",
  disclaimer: [
    "This chatbot uses artificial intelligence to assist with general product information and support. While we work hard to ensure our responses are accurate and helpful, the information provided by the AI may not always capture every detail, specification, or compatibility consideration for your unique needs.",
    "For expert advice tailored to your situation, we encourage you to connect with a MegaBuy product specialist before making a purchase.",
    "Please do not enter any personal or sensitive information, such as your full name, address, payment details, or account numbers, while interacting with the chatbot.",
    "MegaBuy cannot be held responsible for any issues that result from relying solely on chatbot responses.",
  ],
  seedQuestions: {
    displayCount: 3,
    fallback: [
      "What are the key features of this product?",
      "How do I get started?",
      "What maintenance is required?",
      "What's included in the package?",
      "What safety information should I know about?",
    ],
  },
} as const;
