export type SlotSpec = { contract: string; required?: boolean };

export type StepSource = {
  name: string; // engine name, e.g. "watch-ci"
  plugin: string; // e.g. "mattstack"
  version: string; // plugin version string
  dir: string; // absolute source dir
  body: string; // frontmatter-stripped markdown
  slots: Record<string, SlotSpec>;
  allowedTools: string[]; // raw entries from frontmatter allowed-tools
  scriptFiles: string[]; // paths relative to dir under scripts/, may be empty
};

export type AttachmentSource = {
  binding: string; // e.g. "claimview:watch-ci-domain"
  plugin: string;
  version: string;
  dir: string;
  body: string;
  provides: string; // frontmatter metadata.provides, e.g. "watch-ci-domain@1"
  allowedTools: string[];
  extraFiles: string[]; // non-SKILL.md files relative to dir, vendored under parts/<slot>/
  registered: boolean; // true = top-level skill under skills/, referenced not inlined; false = internal attachment under attachments/, inlined
};

export type VerbDef = { name: string; engine: string; description: string };

export type CompiledFile = { path: string; content: string } | { path: string; copyFrom: string };

export type CompileResult = { files: CompiledFile[]; warnings: string[]; errors: string[] };
