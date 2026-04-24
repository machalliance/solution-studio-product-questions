import { describe, it, expect } from "vitest";
import { config } from "./config";

describe("config", () => {
  it("has all required chat copy fields", () => {
    expect(config.chat.header).toBeTruthy();
    expect(config.chat.placeholder).toBeTruthy();
    expect(config.chat.introText).toBeTruthy();
    expect(config.chat.errorMessage).toBeTruthy();
  });

  it("has escalation message", () => {
    expect(config.escalation.message).toBeTruthy();
    expect(config.escalation.message).toContain("customer support");
  });

  it("has seed question configuration", () => {
    expect(config.seedQuestions.displayCount).toBe(3);
    expect(config.seedQuestions.totalGenerated).toBe(15);
    expect(config.seedQuestions.fallback).toHaveLength(5);
  });

  it("has product configuration", () => {
    expect(config.product.defaultProductId).toBe("dreame-x40-ultra");
  });

  it("has chat send button and typing indicator copy", () => {
    expect(config.chat.sendButton).toBeTruthy();
    expect(config.chat.typingIndicator).toBeTruthy();
  });

  it("has PDP copy fields", () => {
    expect(config.pdp.addToCart).toBeTruthy();
    expect(config.pdp.buyNow).toBeTruthy();
    expect(config.pdp.freeShipping).toBeTruthy();
    expect(config.pdp.inStock).toBeTruthy();
    expect(config.pdp.descriptionHeader).toBeTruthy();
    expect(config.pdp.specificationsHeader).toBeTruthy();
    expect(config.pdp.featuresHeader).toBeTruthy();
  });

  it("has widget copy fields for iFit parity", () => {
    expect(config.widget.title).toBeTruthy();
    expect(config.widget.subtitle).toBeTruthy();
    expect(config.widget.inputPlaceholder).toBeTruthy();
    expect(config.widget.askButton).toBeTruthy();
    expect(config.widget.faqHeader).toBeTruthy();
    expect(config.widget.loadingMessages).toHaveLength(3);
    expect(config.widget.disclaimerLinkText).toBeTruthy();
    expect(config.widget.disclaimerHeader).toBeTruthy();
    expect(config.widget.disclaimer.length).toBeGreaterThanOrEqual(4);
  });
});
