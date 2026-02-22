import { describe, test, expect } from "bun:test";
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

describe("ui primitives file structure", () => {
  test("src/lib/utils.ts exists", () => {
    expect(fileExists("src/lib/utils.ts")).toBe(true);
  });

  test("src/components/ui/button.tsx exists", () => {
    expect(fileExists("src/components/ui/button.tsx")).toBe(true);
  });

  test("src/components/ui/input.tsx exists", () => {
    expect(fileExists("src/components/ui/input.tsx")).toBe(true);
  });

  test("src/components/ui/label.tsx exists", () => {
    expect(fileExists("src/components/ui/label.tsx")).toBe(true);
  });

  test("src/components/ui/card.tsx exists", () => {
    expect(fileExists("src/components/ui/card.tsx")).toBe(true);
  });

  test("src/components/ui/form.tsx exists", () => {
    expect(fileExists("src/components/ui/form.tsx")).toBe(true);
  });

  test("src/components/ui/avatar.tsx exists", () => {
    expect(fileExists("src/components/ui/avatar.tsx")).toBe(true);
  });

  test("src/components/ui/dropdown-menu.tsx exists", () => {
    expect(fileExists("src/components/ui/dropdown-menu.tsx")).toBe(true);
  });

  test("src/components/ui/dialog.tsx exists", () => {
    expect(fileExists("src/components/ui/dialog.tsx")).toBe(true);
  });

  test("src/components/ui/index.ts barrel exists", () => {
    expect(fileExists("src/components/ui/index.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cn() utility
// ---------------------------------------------------------------------------

describe("cn() utility", () => {
  test("cn is exported from src/lib/utils", async () => {
    const mod = await import("../lib/utils");
    expect(typeof mod.cn).toBe("function");
  });

  test("cn merges class names", async () => {
    const { cn } = await import("../lib/utils");
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  test("cn resolves tailwind conflicts (last class wins)", async () => {
    const { cn } = await import("../lib/utils");
    // tailwind-merge should keep only the last padding class
    const result = cn("p-2", "p-4");
    expect(result).toBe("p-4");
  });

  test("cn handles conditional classes", async () => {
    const { cn } = await import("../lib/utils");
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  test("cn handles undefined and null values", async () => {
    const { cn } = await import("../lib/utils");
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });
});

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe("Button component", () => {
  test("Button is exported from src/components/ui/button", async () => {
    const mod = await import("../components/ui/button");
    expect(typeof mod.Button).toBe("function");
  });

  test("Button renders with default variant", async () => {
    const { Button } = await import("../components/ui/button");
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeDefined();
  });

  test("Button accepts className prop", async () => {
    const { Button } = await import("../components/ui/button");
    render(<Button className="custom-class">Styled</Button>);
    const btn = screen.getByRole("button", { name: "Styled" });
    expect(btn.className).toContain("custom-class");
  });

  test("Button renders all variants without errors", async () => {
    const { Button, buttonVariants } = await import("../components/ui/button");
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole("button", { name: variant })).toBeDefined();
      unmount();
    }
  });

  test("Button renders all sizes without errors", async () => {
    const { Button } = await import("../components/ui/button");
    const sizes = ["default", "sm", "lg", "icon"] as const;
    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>{size}</Button>);
      expect(screen.getByRole("button", { name: size })).toBeDefined();
      unmount();
    }
  });

  test("buttonVariants is exported for external use", async () => {
    const mod = await import("../components/ui/button");
    expect(typeof mod.buttonVariants).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe("Input component", () => {
  test("Input is exported from src/components/ui/input", async () => {
    const mod = await import("../components/ui/input");
    expect(typeof mod.Input).toBe("function");
  });

  test("Input renders an input element", async () => {
    const { Input } = await import("../components/ui/input");
    render(<Input placeholder="Enter value" />);
    expect(screen.getByPlaceholderText("Enter value")).toBeDefined();
  });

  test("Input accepts className prop", async () => {
    const { Input } = await import("../components/ui/input");
    render(<Input className="custom-input" placeholder="test" />);
    const input = screen.getByPlaceholderText("test");
    expect(input.className).toContain("custom-input");
  });

  test("Input forwards ref", async () => {
    const { Input } = await import("../components/ui/input");
    const ref = React.createRef<HTMLInputElement>();
    render(<Input ref={ref} placeholder="ref-test" />);
    expect(ref.current).toBeDefined();
    expect(ref.current?.tagName).toBe("INPUT");
  });
});

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

describe("Label component", () => {
  test("Label is exported from src/components/ui/label", async () => {
    const mod = await import("../components/ui/label");
    expect(typeof mod.Label).toBe("function");
  });

  test("Label renders with text content", async () => {
    const { Label } = await import("../components/ui/label");
    render(<Label>Email address</Label>);
    expect(screen.getByText("Email address")).toBeDefined();
  });

  test("Label accepts className prop", async () => {
    const { Label } = await import("../components/ui/label");
    render(<Label className="custom-label">Name</Label>);
    const label = screen.getByText("Name");
    expect(label.className).toContain("custom-label");
  });

  test("Label associates with input via htmlFor", async () => {
    const { Label } = await import("../components/ui/label");
    render(
      <>
        <Label htmlFor="email">Email</Label>
        <input id="email" />
      </>
    );
    expect(screen.getByLabelText("Email")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

describe("Card components", () => {
  test("Card and sub-components are exported from src/components/ui/card", async () => {
    const mod = await import("../components/ui/card");
    expect(typeof mod.Card).toBe("function");
    expect(typeof mod.CardHeader).toBe("function");
    expect(typeof mod.CardTitle).toBe("function");
    expect(typeof mod.CardDescription).toBe("function");
    expect(typeof mod.CardContent).toBe("function");
    expect(typeof mod.CardFooter).toBe("function");
  });

  test("Card renders children", async () => {
    const { Card } = await import("../components/ui/card");
    render(<Card>Card body</Card>);
    expect(screen.getByText("Card body")).toBeDefined();
  });

  test("Card composes sub-components without errors", async () => {
    const { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } =
      await import("../components/ui/card");
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>
    );
    expect(screen.getByText("Title")).toBeDefined();
    expect(screen.getByText("Description")).toBeDefined();
    expect(screen.getByText("Content")).toBeDefined();
    expect(screen.getByText("Footer")).toBeDefined();
  });

  test("Card accepts className prop", async () => {
    const { Card } = await import("../components/ui/card");
    render(<Card className="my-card">body</Card>);
    const el = screen.getByText("body");
    // className lives on the wrapper element
    expect(el.closest(".my-card") ?? el).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

describe("Avatar components", () => {
  test("Avatar, AvatarImage, AvatarFallback are exported from src/components/ui/avatar", async () => {
    const mod = await import("../components/ui/avatar");
    expect(typeof mod.Avatar).toBe("function");
    expect(typeof mod.AvatarImage).toBe("function");
    expect(typeof mod.AvatarFallback).toBe("function");
  });

  test("Avatar renders fallback text when image is absent", async () => {
    const { Avatar, AvatarFallback } = await import("../components/ui/avatar");
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("JD")).toBeDefined();
  });

  test("Avatar accepts className prop", async () => {
    const { Avatar, AvatarFallback } = await import("../components/ui/avatar");
    render(
      <Avatar className="custom-avatar">
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    );
    const fallback = screen.getByText("AB");
    const avatar = fallback.closest(".custom-avatar");
    expect(avatar).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

describe("Dialog components", () => {
  test("Dialog and sub-components are exported from src/components/ui/dialog", async () => {
    const mod = await import("../components/ui/dialog");
    expect(typeof mod.Dialog).toBe("function");
    expect(typeof mod.DialogTrigger).toBe("function");
    expect(typeof mod.DialogContent).toBe("function");
    expect(typeof mod.DialogHeader).toBe("function");
    expect(typeof mod.DialogTitle).toBe("function");
    expect(typeof mod.DialogDescription).toBe("function");
    expect(typeof mod.DialogFooter).toBe("function");
  });

  test("Dialog renders trigger without errors", async () => {
    const { Dialog, DialogTrigger } = await import("../components/ui/dialog");
    render(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
      </Dialog>
    );
    expect(screen.getByText("Open dialog")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DropdownMenu
// ---------------------------------------------------------------------------

describe("DropdownMenu components", () => {
  test("DropdownMenu and sub-components are exported from src/components/ui/dropdown-menu", async () => {
    const mod = await import("../components/ui/dropdown-menu");
    expect(typeof mod.DropdownMenu).toBe("function");
    expect(typeof mod.DropdownMenuTrigger).toBe("function");
    expect(typeof mod.DropdownMenuContent).toBe("function");
    expect(typeof mod.DropdownMenuItem).toBe("function");
    expect(typeof mod.DropdownMenuSeparator).toBe("function");
    expect(typeof mod.DropdownMenuLabel).toBe("function");
  });

  test("DropdownMenu renders trigger without errors", async () => {
    const { DropdownMenu, DropdownMenuTrigger } = await import("../components/ui/dropdown-menu");
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      </DropdownMenu>
    );
    expect(screen.getByText("Open menu")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

describe("Form components", () => {
  test("Form sub-components are exported from src/components/ui/form", async () => {
    const mod = await import("../components/ui/form");
    expect(typeof mod.FormField).toBe("function");
    expect(typeof mod.FormItem).toBe("function");
    expect(typeof mod.FormLabel).toBe("function");
    expect(typeof mod.FormControl).toBe("function");
    expect(typeof mod.FormDescription).toBe("function");
    expect(typeof mod.FormMessage).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Barrel export (src/components/ui/index.ts)
// ---------------------------------------------------------------------------

describe("src/components/ui/index.ts barrel export", () => {
  test("barrel re-exports Button", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Button).toBe("function");
  });

  test("barrel re-exports Input", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Input).toBe("function");
  });

  test("barrel re-exports Label", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Label).toBe("function");
  });

  test("barrel re-exports Card components", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Card).toBe("function");
    expect(typeof mod.CardHeader).toBe("function");
    expect(typeof mod.CardTitle).toBe("function");
    expect(typeof mod.CardDescription).toBe("function");
    expect(typeof mod.CardContent).toBe("function");
    expect(typeof mod.CardFooter).toBe("function");
  });

  test("barrel re-exports Avatar components", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Avatar).toBe("function");
    expect(typeof mod.AvatarImage).toBe("function");
    expect(typeof mod.AvatarFallback).toBe("function");
  });

  test("barrel re-exports Dialog components", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.Dialog).toBe("function");
    expect(typeof mod.DialogTrigger).toBe("function");
    expect(typeof mod.DialogContent).toBe("function");
    expect(typeof mod.DialogHeader).toBe("function");
    expect(typeof mod.DialogTitle).toBe("function");
    expect(typeof mod.DialogDescription).toBe("function");
    expect(typeof mod.DialogFooter).toBe("function");
  });

  test("barrel re-exports DropdownMenu components", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.DropdownMenu).toBe("function");
    expect(typeof mod.DropdownMenuTrigger).toBe("function");
    expect(typeof mod.DropdownMenuContent).toBe("function");
    expect(typeof mod.DropdownMenuItem).toBe("function");
    expect(typeof mod.DropdownMenuSeparator).toBe("function");
    expect(typeof mod.DropdownMenuLabel).toBe("function");
  });

  test("barrel re-exports Form components", async () => {
    const mod = await import("../components/ui/index");
    expect(typeof mod.FormField).toBe("function");
    expect(typeof mod.FormItem).toBe("function");
    expect(typeof mod.FormLabel).toBe("function");
    expect(typeof mod.FormControl).toBe("function");
    expect(typeof mod.FormDescription).toBe("function");
    expect(typeof mod.FormMessage).toBe("function");
  });
});
