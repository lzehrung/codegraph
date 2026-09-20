/**
 * Per-format choices over the HTML a document can embed.
 *
 * Before this table existed the document formats each picked their own subset by
 * hand: Markdown and AsciiDoc called the attribute walker with `{a: ["href"]}`,
 * Handlebars and Astro passed the full default tag set, Astro ran the inline
 * `<script>` pass and Handlebars ran neither inline pass, and reStructuredText
 * ran no HTML pass at all. Identical markup therefore produced different edges
 * per format with no stated reason.
 *
 * Every format now starts from `SHARED_HTML_TAG_ATTRS` plus the inline
 * `<script>` and `<style>` passes, and a format may diverge only by naming the
 * shared form it omits in `optOuts`, one line per omission. The language-parity
 * notes quote those lines, and `tests/document-links.test.ts` asserts that every
 * omission is named, so an opt-out cannot flip silently.
 */

/**
 * Tag/attribute pairs every format that walks embedded HTML shares. This is the
 * HTML document walker's own table; the graph's HTML path uses it verbatim, and
 * a format narrows it only through `optOuts`.
 */
export const SHARED_HTML_TAG_ATTRS: Record<string, string[]> = {
  script: ["src"],
  link: ["href"],
  a: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src"],
  audio: ["src"],
  iframe: ["src"],
  track: ["src"],
};

export interface DocumentHtmlForm {
  /** Tag/attribute pairs walked from embedded HTML; `null` disables the pass. */
  attributes: Record<string, string[]> | null;
  inlineScript: boolean;
  inlineStyle: boolean;
  /**
   * One-line reason for each omitted shared tag or pass, keyed by the omitted
   * name (`attributes`, a tag name, `inlineScript`, or `inlineStyle`).
   */
  optOuts: Record<string, string>;
}

export type DocumentHtmlFormId = "html" | "astro" | "hbs" | "markdown" | "mdx" | "adoc" | "rst";

function attributesExcept(omittedTags: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [tag, attributeNames] of Object.entries(SHARED_HTML_TAG_ATTRS)) {
    if (omittedTags.includes(tag)) continue;
    out[tag] = attributeNames;
  }
  return out;
}

/**
 * Embedded HTML is HTML, so a raw `script`/`link`/media form is a real asset
 * dependency in any format that carries it. Images are the one exception the
 * prose formats keep from their own image syntax: `![alt](src)`, `!image(...)`,
 * and their equivalents are deliberately not dependency edges, so the raw image
 * forms are not either.
 */
function htmlFormExceptImageSources(imageSyntax: string): DocumentHtmlForm {
  return {
    attributes: attributesExcept(["img", "source"]),
    inlineScript: true,
    inlineStyle: true,
    optOuts: {
      img: `${imageSyntax} is deliberately not a dependency edge, so a raw img form is not one either`,
      source: "source srcset candidates are image sources, covered by the same image exclusion",
    },
  };
}

const FULL_HTML_FORM: DocumentHtmlForm = {
  attributes: SHARED_HTML_TAG_ATTRS,
  inlineScript: true,
  inlineStyle: true,
  optOuts: {},
};

export const DOCUMENT_HTML_FORMS: Record<DocumentHtmlFormId, DocumentHtmlForm> = {
  /**
   * The reference row every opt-out is measured against; the shared extractor's
   * invariant test asserts it is the shared table with both inline passes on.
   * HTML documents themselves are walked by `src/graphs/specifiers.ts`.
   */
  html: FULL_HTML_FORM,
  astro: FULL_HTML_FORM,
  hbs: FULL_HTML_FORM,
  markdown: htmlFormExceptImageSources("Markdown image syntax"),
  mdx: htmlFormExceptImageSources("MDX image syntax"),
  adoc: htmlFormExceptImageSources("AsciiDoc inline image syntax"),
  rst: {
    attributes: null,
    inlineScript: false,
    inlineStyle: false,
    optOuts: {
      attributes:
        "reStructuredText HTML appears only in raw:: html bodies and inline literals, which its directive model does not separate",
      inlineScript: "an inline script in reStructuredText is raw HTML, covered by the attribute opt-out",
      inlineStyle: "an inline style in reStructuredText is raw HTML, covered by the attribute opt-out",
    },
  },
};
