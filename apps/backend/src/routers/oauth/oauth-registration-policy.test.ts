import { describe, expect, it } from "vitest";
import { permittedDcrGrantTypes } from "./oauth-registration-policy";

describe("ChatGPT DCR registration grants", () => {
  it("defaults to the supported authorization-code grant", () => {
    expect(permittedDcrGrantTypes(undefined)).toEqual(["authorization_code"]);
  });
  it("accepts ChatGPT requesting optional refresh support without falsely advertising it", () => {
    expect(permittedDcrGrantTypes(["authorization_code", "refresh_token"])).toEqual(["authorization_code"]);
    expect(permittedDcrGrantTypes(["authorization_code"])).toEqual(["authorization_code"]);
  });
  it.each([["client_credentials"],["refresh_token"],["authorization_code","password"],"authorization_code",null,[]])("rejects invalid/unsupported grants", (value) => {
    expect(permittedDcrGrantTypes(value)).toBeNull();
  });
});
