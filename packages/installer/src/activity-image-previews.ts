import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Captures = Record<string, string>;
type Rewrite = readonly [pattern: RegExp, replace: (groups: Captures, match: string) => string];

const ident = String.raw`[$\w]+`;
const viewQueryPrefix = '"image-view:"';

// Keep tool-call identity alongside the path through grouping and rendering.
// The query reads the original path, while image actions use the resolved bytes.
const patches = [
  {
    name: "image-view-items",
    matches: (source: string) => source.includes('type:"image-view",') && source.includes("imagePaths:"),
    rewrites: [[
      new RegExp(String.raw`case"imageView":if\(null!=(?<group>${ident})\)\{\k<group>\.imageCount\+=1,\k<group>\.imagePaths\.push\((?<item>${ident})\.path\);break\}\k<group>=\{type:"image-view",id:\k<item>\.id,imageCount:1,imagePaths:\[\k<item>\.path\]\}`),
      ({ group, item }: Captures) => {
        const image = `{id:${item}.id,path:${item}.path}`;
        return `case"imageView":if(null!=${group}){${group}.imageCount+=1,${group}.viewedImages.push(${image});break}${group}={type:"image-view",id:${item}.id,imageCount:1,viewedImages:[${image}]}`;
      },
    ]],
  },
  {
    name: "image-view-card",
    matches: (source: string) => source.includes("localConversation.imageView.previewAlt") && source.includes(".imagePaths"),
    rewrites: [[
      new RegExp(String.raw`(?<item>${ident})\.imagePaths\?\(${ident}=\k<item>\.imagePaths\?\?\[\],${ident}\[\d+\]=\k<item>\.imagePaths,`),
      (_groups: Captures, match: string) => match.replaceAll(".imagePaths", ".viewedImages").replace("??[]", ""),
    ]],
  },
  {
    name: "attachment-gallery",
    matches: (source: string) => source.includes("BW:function") && source.includes("previewFrameClassName:") && source.includes('"sent-image-thumbnail"'),
    rewrites: [[
      new RegExp(String.raw`BW:function\(${ident}\)\{(?=let [^{};]+,\{srcs:)`),
      (_groups: Captures, match: string) => `${match}const imageKey=source=>typeof source==="string"?source:source.id;`,
    ], [
      new RegExp(String.raw`\((?<src>${ident}),(?<index>${ident})\)=>(?<unavailable>${ident})\[\k<index>\]===\k<src>\?\[\]:\[\k<index>\]`),
      ({ src, index, unavailable }: Captures) => `(${src},${index})=>${unavailable}[${index}]===imageKey(${src})?[]:[${index}]`,
    ], [
      new RegExp(String.raw`(?<start>\((?<src>${ident}),${ident}\)=>\(0,${ident}\.jsx\)\(${ident},\{)src:\k<src>,(?=conversationId:${ident},imageLocation:${ident},hostId:${ident},alt:${ident},availableImageCount:)`),
      ({ start, src }: Captures) => `${start}src:typeof ${src}==="string"?${src}:${src}.path,imageViewId:typeof ${src}==="string"?void 0:${src}.id,`,
    ], [
      new RegExp(String.raw`if\((?<available>${ident})===\((?<previous>${ident})\[(?<index>${ident})\]!==(?<src>${ident})\)\)return \k<previous>;let (?<next>${ident})=\[\.\.\.\k<previous>\];return \k<next>\[\k<index>\]=\k<available>\?void 0:\k<src>,\k<next>`),
      ({ available, previous, index, src, next }: Captures) =>
        `const key=imageKey(${src});if(${available}===(${previous}[${index}]!==key))return ${previous};let ${next}=[...${previous}];return ${next}[${index}]=${available}?void 0:key,${next}`,
    ], [
      new RegExp(String.raw`(?<start>disableOpenAnimation:!0\},\x60\$\{${ident}\}:)\$\{(?<src>${ident})\}(?=\x60)`),
      ({ start, src }: Captures) => `${start}\${imageKey(${src})}`,
    ], [
      new RegExp(String.raw`\{src:${ident},conversationId:${ident},imageLocation:${ident},chatGptConversationId:${ident},hostId:${ident},alt:${ident},availableImageCount:`),
      (_groups: Captures, match: string) => `{imageViewId,${match.slice(1)}`,
    ], [
      new RegExp(String.raw`(?<start>\(0,${ident}\.${ident}\)\(${ident},)null==(?<thumbnail>${ident})\?void 0:(?<query>${ident})\?\.dataUpdatedAt(?=\),${ident}=null==${ident}\?${ident}:${ident}\.dataUrl\?\?\k<thumbnail>)`),
      ({ start, thumbnail, query }: Captures) =>
        `${start}null!=imageViewId?${viewQueryPrefix}+imageViewId:null==${thumbnail}?void 0:${query}?.dataUpdatedAt`,
    ], [
      new RegExp(String.raw`displaySrc:(?<display>${ident}),hostId:${ident},image:\{kind:"generic",src:(?<src>${ident}),alt:${ident}\},imageAssetResolver:`),
      ({ display, src }: Captures, match: string) =>
        match.replace(`src:${src},`, `src:null==imageViewId?${src}:${display},imageViewSource:null==imageViewId?void 0:${src},`),
    ]],
  },
  {
    name: "worktree-image-query",
    matches: (source: string) => source.includes('"sent-image-original"'),
    rewrites: [[
      new RegExp(String.raw`null!=(?<version>${ident})\?\{\.\.\.\(0,(?<workspace>${ident})\.(?<options>${ident})\)\((?<params>${ident}),\["sent-image-original",\k<version>\]\),gcTime:0\}:`),
      ({ version, workspace, options, params }: Captures, match: string) =>
        `typeof ${version}==="string"&&${version}.startsWith(${viewQueryPrefix})?{...(0,${workspace}.${options})(${params},${version}),staleTime:1/0}:${match}`,
    ]],
  },
  {
    name: "image-context-menu",
    matches: (source: string) => source.includes("getGeneratedImageContextMenuItems:function") && source.includes("contextMenu.copyFailure"),
    rewrites: [[
      new RegExp(String.raw`(?<start>getGeneratedImageContextMenuItems:function\(${ident},\{[^{}\n]+\}\)\{let [^;\n]+?,${ident}=\(0,${ident}\.${ident}\)\()(?<image>${ident})\.src\)(?=,${ident}=function)`),
      ({ start, image }: Captures) => `${start}${image}.imageViewSource??${image}.src)`,
    ]],
  },
] satisfies { name: string; matches: (source: string) => boolean; rewrites: Rewrite[] }[];

type PatchResult = { status: "applied" | "already-applied" } | { status: "unsupported"; reason: string };

export function patchActivityImagePreviews(appDir: string): PatchResult {
  const assets = join(appDir, "webview", "assets");
  if (!existsSync(assets)) return { status: "unsupported", reason: "renderer assets not found" };

  const found = new Set<string>();
  const changes = new Map<string, string>();
  for (const file of rendererChunks(assets)) {
    const original = readFileSync(file, "utf8");
    let source = original;
    for (const { name, matches, rewrites } of patches) {
      const marker = `/* codexdc:${name} */`;
      if (!source.includes(marker)) {
        if (!matches(original)) continue;
        for (const [pattern, replace] of rewrites) {
          const [hit, duplicate] = source.matchAll(new RegExp(pattern, "g"));
          if (!hit || duplicate) {
            return { status: "unsupported", reason: `${name} changed in ${file.slice(assets.length + 1)}` };
          }
          source = source.slice(0, hit.index) + replace(hit.groups ?? {}, hit[0]) + source.slice(hit.index + hit[0].length);
        }
        source = `${marker}\n${source}`;
      }
      found.add(name);
    }
    if (source !== original) changes.set(file, source);
  }

  // Rspack can load any copy of a duplicated module. Stage all edits before
  // writing so the card, gallery, query and menu always change together.
  const missing = patches.filter(({ name }) => !found.has(name));
  if (missing.length > 0) {
    return { status: "unsupported", reason: `missing ${missing.map(({ name }) => name).join(", ")}` };
  }
  for (const [file, source] of changes) writeFileSync(file, source);
  return { status: changes.size > 0 ? "applied" : "already-applied" };
}

function* rendererChunks(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* rendererChunks(file);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield file;
  }
}
