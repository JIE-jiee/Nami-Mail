import { describe, expect, it } from "vitest";
import {
  canonicalGmailEmail,
  computeEmailAfterProviderSelect,
  neteasePortalUrl,
  normalizeAppPassword,
  surfacesExtraProvider,
} from "./AddAccountModal";

describe("canonicalGmailEmail", () => {
  it("keeps a plain address unchanged", () => {
    expect(canonicalGmailEmail("user@gmail.com")).toBe("user@gmail.com");
  });

  it("drops the +tag on gmail.com", () => {
    expect(canonicalGmailEmail("user+tag@gmail.com")).toBe("user@gmail.com");
  });

  it("drops the +tag on googlemail.com", () => {
    expect(canonicalGmailEmail("user+shopping@googlemail.com")).toBe("user@googlemail.com");
  });

  it("keeps the tag when the domain is not Gmail", () => {
    expect(canonicalGmailEmail("user+tag@company.com")).toBe("user+tag@company.com");
  });

  it("handles case and whitespace", () => {
    expect(canonicalGmailEmail("  USER+Tag@Gmail.com ")).toBe("user@gmail.com");
  });

  it("keeps an address whose local part starts with a plus empty", () => {
    expect(canonicalGmailEmail("+tag@gmail.com")).toBe("+tag@gmail.com");
  });
});

describe("computeEmailAfterProviderSelect", () => {
  it("auto-fills provider suffix when input is empty and puts cursor before @", () => {
    expect(computeEmailAfterProviderSelect("", "gmail.com")).toEqual({
      nextEmail: "@gmail.com",
      cursorPos: 0,
    });
    expect(computeEmailAfterProviderSelect("   ", "qq.com")).toEqual({
      nextEmail: "@qq.com",
      cursorPos: 0,
    });
  });

  it("swaps suffix and puts cursor at 0 if input only had a suffix", () => {
    expect(computeEmailAfterProviderSelect("@qq.com", "163.com")).toEqual({
      nextEmail: "@163.com",
      cursorPos: 0,
    });
  });

  it("appends provider suffix to existing username and places cursor after username", () => {
    expect(computeEmailAfterProviderSelect("alex", "gmail.com")).toEqual({
      nextEmail: "alex@gmail.com",
      cursorPos: 4,
    });
    expect(computeEmailAfterProviderSelect("john.doe", "outlook.com")).toEqual({
      nextEmail: "john.doe@outlook.com",
      cursorPos: 8,
    });
  });

  it("switches domain for an already typed full email while preserving the username", () => {
    expect(computeEmailAfterProviderSelect("alex@qq.com", "gmail.com")).toEqual({
      nextEmail: "alex@gmail.com",
      cursorPos: 4,
    });
    expect(computeEmailAfterProviderSelect("alex@", "icloud.com")).toEqual({
      nextEmail: "alex@icloud.com",
      cursorPos: 4,
    });
  });

  it("handles custom IMAP selection without forced domain", () => {
    // If user only had "@gmail.com" from previous click, clear to empty
    expect(computeEmailAfterProviderSelect("@gmail.com", undefined)).toEqual({
      nextEmail: "",
      cursorPos: 0,
    });
    // If user already typed custom address, keep it intact
    expect(computeEmailAfterProviderSelect("admin@mycompany.com", undefined)).toEqual({
      nextEmail: "admin@mycompany.com",
      cursorPos: 19,
    });
    expect(computeEmailAfterProviderSelect("admin", undefined)).toEqual({
      nextEmail: "admin",
      cursorPos: 5,
    });
  });
});

describe("neteasePortalUrl", () => {
  it("routes 126 and 163 mail to their own hubs", () => {
    expect(neteasePortalUrl("126.com")).toBe("https://mail.126.com");
    expect(neteasePortalUrl("163.com")).toBe("https://mail.163.com");
  });

  it("routes yeah.net and 188.com to their own portals, not the 163/126 hubs", () => {
    expect(neteasePortalUrl("yeah.net")).toBe("https://www.yeah.net/");
    expect(neteasePortalUrl("188.com")).toBe("https://www.188.com/");
  });

  it("routes VIP domains to their VIP portals", () => {
    expect(neteasePortalUrl("vip.163.com")).toBe("https://vip.163.com/");
    expect(neteasePortalUrl("vip.126.com")).toBe("https://vip.126.com/");
  });

  it("is case-insensitive", () => {
    expect(neteasePortalUrl("YEAH.NET")).toBe("https://www.yeah.net/");
  });
});

describe("normalizeAppPassword", () => {
  it("strips spaces from grouped pastes", () => {
    expect(normalizeAppPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
  });

  it("strips dashes so the official iCloud format passes the 16-char check", () => {
    expect(normalizeAppPassword("abcd-efgh-ijkl-mnop")).toBe("abcdefghijklmnop");
  });

  it("leaves a plain 16-char password unchanged", () => {
    expect(normalizeAppPassword("abcdefghijklmnop")).toBe("abcdefghijklmnop");
  });
});

describe("surfacesExtraProvider", () => {
  const catalog = [
    { id: "gmail" },
    { id: "microsoft" },
    { id: "qq" },
    { id: "netease-163" },
    { id: "netease-126" },
    { id: "icloud" },
    { id: "aol" },
    { id: "netease-yeah" },
    { id: "zoho" },
  ];

  it("keeps core selections inside the always-visible strip", () => {
    expect(surfacesExtraProvider(catalog, "gmail")).toBe(false);
    expect(surfacesExtraProvider(catalog, "icloud")).toBe(false);
  });

  it("surfaces non-core and custom selections that the collapsed strip would hide", () => {
    expect(surfacesExtraProvider(catalog, "netease-yeah")).toBe(true);
    expect(surfacesExtraProvider(catalog, "aol")).toBe(true);
    expect(surfacesExtraProvider(catalog, "__custom_imap__")).toBe(true);
  });

  it("is quiet when nothing is selected", () => {
    expect(surfacesExtraProvider(catalog, "")).toBe(false);
  });
});