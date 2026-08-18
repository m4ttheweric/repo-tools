import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "rt",
  tagline: "Personal developer CLI for branch management, worktrees, and git workflows",
  favicon: "img/favicon.svg",
  url: "https://rt.cool",
  baseUrl: "/",
  organizationName: "m4ttstack",
  projectName: "rt",
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/m4ttstack/rt/tree/main/website/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: "rt",
      items: [
        {
          href: "https://github.com/m4ttstack/rt",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [],
      copyright: "rt ... repo tools",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json"],
    },
    colorMode: { defaultMode: "light", respectPrefersColorScheme: true },
  } satisfies Preset.ThemeConfig,
};

export default config;
