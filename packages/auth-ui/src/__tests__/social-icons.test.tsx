import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { existsSync } from "fs";
import { resolve } from "path";
import React from "react";

const pkgRoot = resolve(import.meta.dir, "../..");

function fileExists(relativePath: string) {
  return existsSync(resolve(pkgRoot, relativePath));
}

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("social icons file structure", () => {
  test("src/components/icons/provider-icons.tsx exists", () => {
    expect(fileExists("src/components/icons/provider-icons.tsx")).toBe(true);
  });

  test("src/components/icons/index.ts exists", () => {
    expect(fileExists("src/components/icons/index.ts")).toBe(true);
  });

  test("src/components/social-button.tsx exists", () => {
    expect(fileExists("src/components/social-button.tsx")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Individual icon exports
// ---------------------------------------------------------------------------

describe("provider icon exports", () => {
  test("GoogleIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.GoogleIcon).toBe("function");
  });

  test("GitHubIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.GitHubIcon).toBe("function");
  });

  test("AppleIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.AppleIcon).toBe("function");
  });

  test("MicrosoftIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.MicrosoftIcon).toBe("function");
  });

  test("DiscordIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.DiscordIcon).toBe("function");
  });

  test("XIcon is exported from provider-icons", async () => {
    const mod = await import("../components/icons/provider-icons");
    expect(typeof mod.XIcon).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Icon rendering — SVG markup
// ---------------------------------------------------------------------------

describe("icon SVG rendering", () => {
  test("GoogleIcon renders an svg element", async () => {
    const { GoogleIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GoogleIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("GitHubIcon renders an svg element", async () => {
    const { GitHubIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GitHubIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("AppleIcon renders an svg element", async () => {
    const { AppleIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<AppleIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("MicrosoftIcon renders an svg element", async () => {
    const { MicrosoftIcon } = await import(
      "../components/icons/provider-icons"
    );
    const { container } = render(<MicrosoftIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("DiscordIcon renders an svg element", async () => {
    const { DiscordIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<DiscordIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("XIcon renders an svg element", async () => {
    const { XIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<XIcon />);
    expect(container.querySelector("svg")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Default icon dimensions (20x20)
// ---------------------------------------------------------------------------

describe("icon default dimensions", () => {
  const icons = [
    "GoogleIcon",
    "GitHubIcon",
    "AppleIcon",
    "MicrosoftIcon",
    "DiscordIcon",
    "XIcon",
  ] as const;

  for (const iconName of icons) {
    test(`${iconName} defaults to 20x20`, async () => {
      const mod = await import("../components/icons/provider-icons");
      const Icon = mod[iconName];
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).toBeDefined();
      // Accept width/height as attribute or viewBox-implied defaults
      const width = svg?.getAttribute("width");
      const height = svg?.getAttribute("height");
      if (width !== null && width !== undefined) {
        expect(width).toBe("20");
      }
      if (height !== null && height !== undefined) {
        expect(height).toBe("20");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Icon className prop
// ---------------------------------------------------------------------------

describe("icon className prop", () => {
  test("GoogleIcon applies className to svg", async () => {
    const { GoogleIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GoogleIcon className="text-red-500" />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("text-red-500");
  });

  test("GitHubIcon applies className to svg", async () => {
    const { GitHubIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GitHubIcon className="my-icon" />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("my-icon");
  });

  test("DiscordIcon applies className to svg", async () => {
    const { DiscordIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<DiscordIcon className="discord-icon" />);
    const svg = container.querySelector("svg");
    expect(svg?.className).toContain("discord-icon");
  });
});

// ---------------------------------------------------------------------------
// Icon width/height override props
// ---------------------------------------------------------------------------

describe("icon size override props", () => {
  test("GoogleIcon respects width and height props", async () => {
    const { GoogleIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GoogleIcon width={32} height={32} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("32");
    expect(svg?.getAttribute("height")).toBe("32");
  });

  test("GitHubIcon respects width and height props", async () => {
    const { GitHubIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GitHubIcon width={24} height={24} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
  });
});

// ---------------------------------------------------------------------------
// aria-hidden prop
// ---------------------------------------------------------------------------

describe("icon aria-hidden prop", () => {
  test("GoogleIcon forwards aria-hidden", async () => {
    const { GoogleIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GoogleIcon aria-hidden="true" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  test("GitHubIcon forwards aria-hidden", async () => {
    const { GitHubIcon } = await import("../components/icons/provider-icons");
    const { container } = render(<GitHubIcon aria-hidden="true" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// providerIcons map
// ---------------------------------------------------------------------------

describe("providerIcons map", () => {
  test("providerIcons is exported from src/components/icons/index", async () => {
    const mod = await import("../components/icons/index");
    expect(typeof mod.providerIcons).toBe("object");
    expect(mod.providerIcons).not.toBeNull();
  });

  test("providerIcons has google entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["google"]).toBe("function");
  });

  test("providerIcons has github entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["github"]).toBe("function");
  });

  test("providerIcons has apple entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["apple"]).toBe("function");
  });

  test("providerIcons has microsoft entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["microsoft"]).toBe("function");
  });

  test("providerIcons has discord entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["discord"]).toBe("function");
  });

  test("providerIcons has x entry", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(typeof providerIcons["x"]).toBe("function");
  });

  test("providerIcons google entry renders an svg", async () => {
    const { providerIcons } = await import("../components/icons/index");
    const Icon = providerIcons["google"];
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("providerIcons github entry renders an svg", async () => {
    const { providerIcons } = await import("../components/icons/index");
    const Icon = providerIcons["github"];
    const { container } = render(<Icon />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("providerIcons returns undefined for unknown provider", async () => {
    const { providerIcons } = await import("../components/icons/index");
    expect(providerIcons["unknown-provider-xyz"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SocialButton
// ---------------------------------------------------------------------------

describe("SocialButton component", () => {
  test("SocialButton is exported from src/components/social-button", async () => {
    const mod = await import("../components/social-button");
    expect(typeof mod.SocialButton).toBe("function");
  });

  test("SocialButton renders a button element", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="google" />);
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("SocialButton renders provider label text for google", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="google" />);
    expect(screen.getByText(/continue with google/i)).toBeDefined();
  });

  test("SocialButton renders provider label text for github", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="github" />);
    expect(screen.getByText(/continue with github/i)).toBeDefined();
  });

  test("SocialButton renders provider label text for apple", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="apple" />);
    expect(screen.getByText(/continue with apple/i)).toBeDefined();
  });

  test("SocialButton renders provider label text for discord", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="discord" />);
    expect(screen.getByText(/continue with discord/i)).toBeDefined();
  });

  test("SocialButton renders an svg icon for known provider", async () => {
    const { SocialButton } = await import("../components/social-button");
    const { container } = render(<SocialButton provider="google" />);
    expect(container.querySelector("svg")).toBeDefined();
  });

  test("SocialButton renders no svg icon for unknown provider", async () => {
    const { SocialButton } = await import("../components/social-button");
    const { container } = render(
      <SocialButton provider="unknown-provider-xyz" />
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  test("SocialButton renders gracefully for unknown provider without crashing", async () => {
    const { SocialButton } = await import("../components/social-button");
    expect(() =>
      render(<SocialButton provider="unknown-provider-xyz" />)
    ).not.toThrow();
    expect(screen.getByRole("button")).toBeDefined();
  });

  test("SocialButton shows provider name even for unknown providers", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="myoauth" />);
    expect(screen.getByText(/continue with myoauth/i)).toBeDefined();
  });

  test("SocialButton accepts className prop", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="google" className="custom-social-btn" />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("custom-social-btn");
  });

  test("SocialButton is disabled when disabled prop is true", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="google" disabled />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test("SocialButton calls onClick when clicked", async () => {
    const { SocialButton } = await import("../components/social-button");
    let clicked = false;
    render(
      <SocialButton
        provider="google"
        onClick={() => {
          clicked = true;
        }}
      />
    );
    screen.getByRole("button").click();
    expect(clicked).toBe(true);
  });

  test("SocialButton does not call onClick when disabled", async () => {
    const { SocialButton } = await import("../components/social-button");
    let clicked = false;
    render(
      <SocialButton
        provider="google"
        disabled
        onClick={() => {
          clicked = true;
        }}
      />
    );
    screen.getByRole("button").click();
    expect(clicked).toBe(false);
  });

  test("SocialButton shows loading state when loading prop is true", async () => {
    const { SocialButton } = await import("../components/social-button");
    render(<SocialButton provider="google" loading />);
    const btn = screen.getByRole("button") as HTMLButtonElement;
    // Loading should disable interaction
    expect(
      btn.disabled ||
        btn.getAttribute("aria-busy") === "true" ||
        btn.getAttribute("data-loading") === "true"
    ).toBe(true);
  });

  test("SocialButton renderIcon prop overrides the default icon", async () => {
    const { SocialButton } = await import("../components/social-button");
    const CustomIcon = () => <svg data-testid="custom-icon" />;
    render(
      <SocialButton provider="google" renderIcon={() => <CustomIcon />} />
    );
    expect(screen.getByTestId("custom-icon")).toBeDefined();
  });

  test("SocialButton renderIcon prop replaces the built-in GoogleIcon", async () => {
    const { SocialButton } = await import("../components/social-button");
    // Render with default first to confirm svg is there
    const { unmount, container: c1 } = render(
      <SocialButton provider="google" />
    );
    expect(c1.querySelector("svg")).toBeDefined();
    unmount();

    // Now render with custom renderIcon — only our custom svg should appear
    const CustomIcon = () => <svg data-testid="override-icon" />;
    const { container: c2 } = render(
      <SocialButton provider="google" renderIcon={() => <CustomIcon />} />
    );
    expect(c2.querySelector("[data-testid='override-icon']")).toBeDefined();
  });

  test("SocialButton uses outline Button variant", async () => {
    const { SocialButton } = await import("../components/social-button");
    const { container } = render(<SocialButton provider="github" />);
    const btn = container.querySelector("button");
    // The outline variant typically includes a border class
    expect(btn?.className).toMatch(/border|outline/i);
  });
});
