import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrowserAppUrl } from "../apps/frontend/lib/local-origin.ts";

test("localhost and 127.0.0.1 are equivalent on the configured local port", () => {
  assert.equal(
    resolveBrowserAppUrl("http://localhost:12008", "http://127.0.0.1:12008"),
    "http://127.0.0.1:12008",
  );
  assert.equal(
    resolveBrowserAppUrl("http://127.0.0.1:12008", "http://localhost:12008"),
    "http://localhost:12008",
  );
  assert.equal(
    resolveBrowserAppUrl("http://localhost:12008", "http://localhost:12008"),
    "http://localhost:12008",
  );
});

test("different ports and protocols remain distinct origins", () => {
  assert.equal(
    resolveBrowserAppUrl("http://localhost:12008", "http://127.0.0.1:12009"),
    "http://localhost:12008",
  );
  assert.equal(
    resolveBrowserAppUrl("http://localhost:12008", "https://127.0.0.1:12008"),
    "http://localhost:12008",
  );
});

test("public URLs and paths are not silently rewritten", () => {
  for (const configured of [
    "https://luckylion.run.place",
    "https://example.com",
    "http://localhost:12008/base",
  ]) {
    assert.equal(
      resolveBrowserAppUrl(configured, "http://127.0.0.1:12008"),
      configured,
    );
  }
});
