import type React from "react";
import type { IconProps } from "./provider-icons";
import {
  GoogleIcon,
  GitHubIcon,
  AppleIcon,
  MicrosoftIcon,
  DiscordIcon,
  XIcon,
} from "./provider-icons";

export type { IconProps };
export { GoogleIcon, GitHubIcon, AppleIcon, MicrosoftIcon, DiscordIcon, XIcon };

export const providerIcons: Record<string, React.ComponentType<IconProps>> = {
  google: GoogleIcon,
  github: GitHubIcon,
  apple: AppleIcon,
  microsoft: MicrosoftIcon,
  discord: DiscordIcon,
  x: XIcon,
};
