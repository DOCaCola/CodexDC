import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchActivityImagePreviews } from "../src/activity-image-previews.js";

// Small renderer fixtures with the same call and memo shapes as the bundle.
const items = `
function groupImages(items){let group;for(const item of items){switch(item.type){
case"imageView":if(null!=group){group.imageCount+=1,group.imagePaths.push(item.path);break}group={type:"image-view",id:item.id,imageCount:1,imagePaths:[item.path]}
}}return group}`;

const gallery = `
const thumbnailKey="sent-image-thumbnail";
function card(item){let memo=[],images;memo[0]!==item.imagePaths?(images=item.imagePaths??[],memo[0]=item.imagePaths,memo[1]=images):images=memo[1];
return gallery.BW({srcs:images,alt:"localConversation.imageView.previewAlt"})}
function attachment(e){
  let {src:s,conversationId:c,imageLocation:l,chatGptConversationId:g,hostId:h,alt:a,availableImageCount:n}=e;
  let file={path:s},thumb=null,query={};
  let data=(0,reader.image)(file,null==thumb?void 0:query?.dataUpdatedAt),display=null==file?s:data.dataUrl??thumb;
  return menu.getGeneratedImageContextMenuItems({},{displaySrc:display,hostId:h,image:{kind:"generic",src:s,alt:a},imageAssetResolver:null});
}
const gallery={BW:function(e){let unavailable=[],{srcs:sources}=e;
  const indices=sources.flatMap((s,i)=>unavailable[i]===s?[]:[i]);
  const setUnavailable=update=>{unavailable=update(unavailable)};
  const c="thread",l=null,h="local",a=e.alt,count=indices.length;
  return sources.map((s,i)=>(0,react.jsx)(attachment,{src:s,conversationId:c,imageLocation:l,hostId:h,alt:a,availableImageCount:count,
    previewFrameClassName:"frame",onPreviewAvailabilityChange:ok=>setUnavailable(previous=>{if(ok===(previous[i]!==s))return previous;let next=[...previous];return next[i]=ok?void 0:s,next}),disableOpenAnimation:!0},\`\${i}:\${s}\`));
}};`;

const query = `
function worktree(params,version){return null!=version?{...(0,workspace.options)(params,["sent-image-original",version]),gcTime:0}:(0,workspace.options)(params)}`;

const contextMenu = `
const menu={getGeneratedImageContextMenuItems:function(context,{displaySrc,image}){let scope=context,path=(0,paths.local)(image.src),filename=function(){return path};
return {display:displaySrc,copy:paths.local(image.src)?readCurrent(path):image.src,path:filename(),failure:"contextMenu.copyFailure"}}};`;

function fixture(t: { after: (callback: () => void) => void }) {
  const app = mkdtempSync(join(tmpdir(), "codexdc-activity-images-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const assets = join(app, "webview", "assets", "async");
  mkdirSync(assets, { recursive: true });
  const chunks = { "items.js": items, "gallery.js": gallery, "query.js": query, "menu.js": contextMenu };
  for (const [name, source] of Object.entries(chunks)) writeFileSync(join(assets, name), source);
  return { app, assets, chunks, read: (name: string) => readFileSync(join(assets, name), "utf8") };
}

test("activity previews use each tool call's query and copy its rendered snapshot", t => {
  const { app, assets, chunks, read } = fixture(t);
  writeFileSync(join(assets, "alternate-query.js"), query);
  writeFileSync(join(assets, "alternate-menu.js"), contextMenu);
  assert.deepEqual(patchActivityImagePreviews(app), { status: "applied" });
  assert.equal(read("alternate-query.js"), read("query.js"));
  assert.equal(read("alternate-menu.js"), read("menu.js"));
  assert.deepEqual(patchActivityImagePreviews(app), { status: "already-applied" });

  const source = Object.keys(chunks).map(read).join("\n");
  const cache = new Map<string, string>();
  const readVersions: string[] = [];
  let current = "data:image/png;base64,red";
  const { groupImages, card, worktree } = runInNewContext(`${source}\n({groupImages,card,worktree})`, {
    react: { jsx: (component: unknown, props: object, key: string) => ({ component, props, key }) },
    paths: { local: (src: string) => src.startsWith("/") ? src : null },
    workspace: { options: (params: object, version: unknown) => ({ params, version }) },
    readCurrent: () => current,
    reader: {
      image: (params: { path: string }, version: string) => {
        const options = worktree(params, version);
        if (!cache.has(options.version)) {
          readVersions.push(options.version);
          cache.set(options.version, current);
        }
        return { dataUrl: cache.get(options.version) };
      },
    },
  });

  const path = "/workspace/frame.png";
  const first = { type: "imageView", id: "first", path };
  const second = { type: "imageView", id: "second", path };
  const [old] = card(groupImages([first]));
  assert.equal(old.component(old.props).display, current);
  current = "data:image/png;base64,blue";
  const grouped = groupImages([first, second]);
  assert.equal(grouped.imageCount, 2);
  const [red, blue] = card(grouped);
  for (const [child, color] of [[red, "red"], [blue, "blue"]]) {
    const image = child.component(child.props);
    assert.equal(image.display, `data:image/png;base64,${color}`);
    assert.equal(image.copy, image.display);
    assert.equal(image.path, path);
  }
  assert.deepEqual(readVersions, ["image-view:first", "image-view:second"]);
  assert.equal(red.key, "0:first");
  assert.equal(blue.key, "1:second");
  assert.equal(worktree({ path }, "image-view:first").staleTime, Infinity);
  assert.equal(worktree({ path }, 42).gcTime, 0);
  assert.equal(worktree({ path }).version, undefined);
});

test("a changed renderer chunk prevents a partial activity preview patch", t => {
  const { app, assets, chunks, read } = fixture(t);
  writeFileSync(join(assets, "query.js"), query.replace("gcTime:0", "gcTime:1000"));
  assert.deepEqual(patchActivityImagePreviews(app), {
    status: "unsupported",
    reason: `worktree-image-query changed in ${join("async", "query.js")}`,
  });
  assert.equal(read("items.js"), chunks["items.js"]);
  assert.equal(read("gallery.js"), chunks["gallery.js"]);
  assert.equal(read("menu.js"), chunks["menu.js"]);
});
