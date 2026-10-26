import { describe, expect, it } from "vitest";
import { assertSecureBootstrapCredentials } from "./bootstrap-credentials-security";

const strong = "NW7_r2cG9wQ5P4zB8uY1kX6hT0sF";
const email = "wachiefmarkus@gmail.com";

describe("safe bootstrap credential policy", () => {
  it("allows a fresh clone with NO preconfigured admin", () => {
    expect(() => assertSecureBootstrapCredentials({})).not.toThrow();
  });

  it("accepts a strongly configured new administrator", () => {
    expect(() =>
      assertSecureBootstrapCredentials({
        BOOTSTRAP_USER_EMAIL: email,
        BOOTSTRAP_USER_PASSWORD: strong,
      }),
    ).not.toThrow();
  });

  it.each([
    ["admin@local.test", strong],
    ["test@user.example", strong],
    ["you@yourdomain.com", strong],
    [email, "replace-with-your-unique-strong-passphrase"],
    ["admin@example.com", strong],
    [email, "admin"],
    [email, "admin123"],
    [email, "admin1234567890qwerty"],
    [email, "aaaaaaaaaaaaaaaaaaaa"],
    [email, "12345678901234567890"],
    [email, "qwertyTEST12345678$$$"],
    [email, " password_is_fine_123456 "],
  ])("blocks sample identities / weak credentials (case %s)", (testEmail, password) => {
    expect(() =>
      assertSecureBootstrapCredentials({
        BOOTSTRAP_USER_EMAIL: testEmail,
        BOOTSTRAP_USER_PASSWORD: password,
      }),
    ).toThrow();
  });

  it("does not accept a half-configured default user", () => {
    expect(() =>
      assertSecureBootstrapCredentials({ BOOTSTRAP_USER_EMAIL: email }),
    ).toThrow();
    expect(() =>
      assertSecureBootstrapCredentials({ BOOTSTRAP_USER_PASSWORD: strong }),
    ).toThrow();
  });

  it("checks BOOTSTRAP_USERS even when BOOTSTRAP_ENABLE=false", () => {
    expect(() =>
      assertSecureBootstrapCredentials({
        BOOTSTRAP_ENABLE: "false",
        BOOTSTRAP_USERS: JSON.stringify([
          { email, password: strong },
          { email: "user@mydomain.com", password: "admin" },
        ]),
      }),
    ).toThrow();
  });

  it("accepts a fully configured secure multiuser bootstrap", () => {
    expect(() =>
      assertSecureBootstrapCredentials({
        BOOTSTRAP_USERS: JSON.stringify([
          { email, password: strong },
          { email: "developer@mydomain.com", password: "X0Mzj_R8v2QhN4Gpb79Va5Tcl" },
        ]),
      }),
    ).not.toThrow();
  });

  it.each(["not-json", "{}", "[null]", '[{"email":"test@example.com"}]'])(
    "refuses malformed BOOTSTRAP_USERS (%s)",
    (users) => {
      expect(() =>
        assertSecureBootstrapCredentials({ BOOTSTRAP_USERS: users }),
      ).toThrow();
    },
  );

  it("does not put any supplied password into validation errors", () => {
    const oldPassword = "shortLegacySecret!";
    expect(() =>
      assertSecureBootstrapCredentials({
        BOOTSTRAP_USER_EMAIL: email,
        BOOTSTRAP_USER_PASSWORD: oldPassword,
      }),
    ).toThrowError(
      expect.not.stringContaining(oldPassword),
    );
  });
});
