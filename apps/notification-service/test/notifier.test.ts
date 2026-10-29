import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.js";
import {
  ChannelRoutedNotifier,
  EmailNotifier,
  MockNotifier,
  NotifierFactory,
  SmsNotifier,
  type OutgoingNotification,
} from "../src/notifier.js";

describe("Notifier Strategy Pattern & Factory", () => {
  const sampleNotification: OutgoingNotification = {
    id: 101,
    channel: "email",
    to: "patient@medlink.health",
    message: "Paracetamol 500mg is back in stock at Apollo Pharmacy (25 available).",
  };

  describe("Strategy Implementations", () => {
    it("MockNotifier captures notifications in memory and enforces keep limit", async () => {
      const mock = new MockNotifier(silentLogger, 2);
      await mock.send({ ...sampleNotification, id: 1 });
      await mock.send({ ...sampleNotification, id: 2 });
      await mock.send({ ...sampleNotification, id: 3 });

      expect(mock.sent.length).toBe(2);
      expect(mock.sent[0]?.id).toBe(2);
      expect(mock.sent[1]?.id).toBe(3);
    });

    it("EmailNotifier validates the address and, unconfigured, fails safely instead of pretending to send", async () => {
      const emailNotifier = new EmailNotifier(silentLogger);
      await expect(emailNotifier.send({ ...sampleNotification, to: "invalid-recipient" })).rejects.toThrow(/Invalid email address destination/);
      await expect(emailNotifier.send(sampleNotification)).rejects.toThrow(/not configured.*Nothing was sent/);
    });

    it("SmsNotifier formats phone number with default country code", async () => {
      const smsNotifier = new SmsNotifier(silentLogger, "+91");
      await expect(
        smsNotifier.send({ ...sampleNotification, channel: "sms", to: "9876543210" }),
      ).resolves.not.toThrow();

      await expect(
        smsNotifier.send({ ...sampleNotification, channel: "sms", to: "   " }),
      ).rejects.toThrow(/SMS destination phone number cannot be empty/);
    });

    it("ChannelRoutedNotifier dynamically delegates to the matching strategy", async () => {
      const fallback = new MockNotifier(silentLogger);
      const emailSpy = new MockNotifier(silentLogger);
      const smsSpy = new MockNotifier(silentLogger);

      const router = new ChannelRoutedNotifier(fallback)
        .registerStrategy("email", emailSpy)
        .registerStrategy("sms", smsSpy);

      await router.send({ ...sampleNotification, channel: "email" });
      await router.send({ ...sampleNotification, channel: "sms", to: "+919876543210" });
      await router.send({ ...sampleNotification, channel: "push", to: "token123" });

      expect(emailSpy.sent.length).toBe(1);
      expect(smsSpy.sent.length).toBe(1);
      expect(fallback.sent.length).toBe(1); // push routed to fallback
    });
  });

  describe("NotifierFactory", () => {
    it("instantiates EmailNotifier when requested", () => {
      const notifier = NotifierFactory.createNotifier("email", silentLogger);
      expect(notifier).toBeInstanceOf(EmailNotifier);
    });

    it("instantiates SmsNotifier when requested", () => {
      const notifier = NotifierFactory.createNotifier("sms", silentLogger);
      expect(notifier).toBeInstanceOf(SmsNotifier);
    });

    it("instantiates MockNotifier by default or on unknown channel", () => {
      const notifier = NotifierFactory.createNotifier("unknown", silentLogger);
      expect(notifier).toBeInstanceOf(MockNotifier);
    });

    it("instantiates ChannelRoutedNotifier for composite configuration", () => {
      const notifier = NotifierFactory.createNotifier("composite", silentLogger);
      expect(notifier).toBeInstanceOf(ChannelRoutedNotifier);
    });
  });
});
