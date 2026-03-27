import { describe, it, expect } from "vitest";
import { getService, listServices, type ServiceDefinition } from "../../../src/services/catalog.js";

describe("Service catalog", () => {
  it("lists all available services", () => {
    const services = listServices();
    expect(services.length).toBeGreaterThanOrEqual(6);
    const ids = services.map(s => s.id);
    expect(ids).toContain("google");
    expect(ids).toContain("github");
    expect(ids).toContain("vk");
    expect(ids).toContain("yandex");
    expect(ids).toContain("reddit");
    expect(ids).toContain("mailru");
  });

  it("getService returns a service by id", () => {
    const google = getService("google");
    expect(google).not.toBeNull();
    expect(google!.name).toBe("Google");
    expect(google!.scopes).toHaveProperty("gmail");
    expect(google!.actions).toHaveProperty("gmail");
  });

  it("getService returns null for unknown service", () => {
    expect(getService("nonexistent")).toBeNull();
  });

  it("google has gmail actions", () => {
    const google = getService("google")!;
    const gmailActions = google.actions.gmail;
    expect(gmailActions.length).toBeGreaterThan(0);
    const names = gmailActions.map(a => a.name);
    expect(names).toContain("list_messages");
    expect(names).toContain("get_message");
    expect(names).toContain("send_message");
  });

  it("google has youtube actions", () => {
    const google = getService("google")!;
    const ytActions = google.actions.youtube;
    expect(ytActions.length).toBeGreaterThan(0);
  });

  it("each service has required fields", () => {
    for (const svc of listServices()) {
      expect(svc.id).toBeTruthy();
      expect(svc.name).toBeTruthy();
      expect(svc.description).toBeTruthy();
      expect(svc.relayUrl).toBe("https://auth.betsyai.io");
      expect(Object.keys(svc.scopes).length).toBeGreaterThan(0);
      expect(Object.keys(svc.baseUrls).length).toBeGreaterThan(0);
    }
  });
});
