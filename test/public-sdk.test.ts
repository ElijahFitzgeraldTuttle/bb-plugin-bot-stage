// Guards the package's dependency surface: Bot Stage may only reach for the
// public Plugin SDK, zod, node builtins, and its own files. Run in the same
// suite so an import that quietly reaches into BB internals fails the build.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("public SDK only", () => {
  it("imports nothing private", () => {
    const { violations, privateDependencies } = experimental_scanPublicSdkOnly(root, {
      allow: [
        /^zod$/,
        /^node:/,
        // bb-shimmed at runtime, and the test and preview tooling beside it.
        /^(react|react-dom|react-dom\/client)$/,
        /^vitest(\/config)?$/,
        /^@testing-library\//,
        /^esbuild$/,
      ],
    });
    expect(violations).toEqual([]);
    expect(privateDependencies).toEqual([]);
  });
});
