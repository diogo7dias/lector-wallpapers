import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceDir=path.resolve(process.argv[2]??path.join(process.env.HOME,"Downloads"));
const galleryDir=path.resolve(new URL("../gallery/",import.meta.url).pathname);
const parentDir=path.dirname(galleryDir);
const stagingDir=path.join(parentDir,`.gallery-staging-${process.pid}`);
const backupDir=path.join(parentDir,`.gallery-backup-${process.pid}`);

const hashBytes=bytes=>createHash("sha256").update(bytes).digest("hex");
async function exists(target){try{await access(target);return true;}catch{return false;}}

async function findPxcFiles(dir){
  const found=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const fullPath=path.join(dir,entry.name);
    if(entry.isDirectory()) found.push(...await findPxcFiles(fullPath));
    else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".pxc")) found.push(fullPath);
  }
  return found;
}

async function existingAssignments(){
  const assignments=new Map();
  if(!(await exists(galleryDir))) return assignments;
  for(const name of (await readdir(galleryDir)).filter(name=>/^\d+\.pxc$/i.test(name)).sort()){
    assignments.set(hashBytes(await readFile(path.join(galleryDir,name))),name);
  }
  return assignments;
}

const sourceFiles=(await findPxcFiles(sourceDir)).sort((a,b)=>a<b?-1:a>b?1:0);
const unique=[];
const duplicates=[];
const sourcesByHash=new Map();

for(const source of sourceFiles){
  const bytes=await readFile(source);
  if(bytes.length<4) throw new Error(`Invalid PXC header: ${source}`);
  const width=bytes.readUInt16LE(0),height=bytes.readUInt16LE(2);
  if(!((width===528&&height===792)||(width===480&&height===800))){
    throw new Error(`Unsupported PXC size ${width}x${height}: ${source}`);
  }
  const expectedLength=4+Math.ceil(width/4)*height;
  if(bytes.length!==expectedLength){
    throw new Error(`Invalid PXC length ${bytes.length}, expected ${expectedLength}: ${source}`);
  }
  const sha256=hashBytes(bytes);
  if(sourcesByHash.has(sha256)){
    duplicates.push({duplicate:source,kept:sourcesByHash.get(sha256)});
    continue;
  }
  sourcesByHash.set(sha256,source);
  unique.push({source,width,height,sha256});
}

const previous=await existingAssignments();
const usedNames=new Set();
let nextId=Math.max(0,...[...previous.values()].map(name=>Number.parseInt(name,10)||0));
for(const item of unique){
  const prior=previous.get(item.sha256);
  if(prior&&!usedNames.has(prior)){item.file=prior;usedNames.add(prior);}
}
for(const item of unique.filter(item=>!item.file).sort((a,b)=>a.sha256<b.sha256?-1:1)){
  do{nextId++;item.file=`${String(nextId).padStart(4,"0")}.pxc`;}while(usedNames.has(item.file));
  usedNames.add(item.file);
}
unique.sort((a,b)=>a.file.localeCompare(b.file,"en"));

await rm(stagingDir,{recursive:true,force:true});
await rm(backupDir,{recursive:true,force:true});
let oldMoved=false;
try{
  await mkdir(stagingDir,{recursive:true});

for(const item of unique){
  const target=path.join(stagingDir,item.file);
  await copyFile(item.source,target);
  await chmod(target,0o644);
  if(hashBytes(await readFile(target))!==item.sha256) throw new Error(`Copy verification failed: ${item.file}`);
}

const manifest={
  note:"Ready-made Lector / CrossPoint wallpapers. Files keep their original PXC bytes and use stable sequential gallery names. X3 and X4 masters are decoded in-browser and converted to other device formats only when requested.",
  wallpapers:unique.map(({file})=>({file})),
};
const hashes=unique.map(({file,sha256})=>({file,sha256}));
await writeFile(path.join(stagingDir,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`);
await writeFile(path.join(stagingDir,"hashes.json"),`${JSON.stringify(hashes,null,2)}\n`);

  if(await exists(galleryDir)){await rename(galleryDir,backupDir);oldMoved=true;}
  await rename(stagingDir,galleryDir);
  if(oldMoved) await rm(backupDir,{recursive:true,force:true});
}catch(error){
  if(oldMoved&&!(await exists(galleryDir))&&await exists(backupDir)) await rename(backupDir,galleryDir);
  throw error;
}finally{
  await rm(stagingDir,{recursive:true,force:true});
}

console.log(JSON.stringify({
  sourceFiles:sourceFiles.length,
  imported:unique.length,
  dimensions:unique.reduce((counts,item)=>{
    const key=`${item.width}x${item.height}`;
    counts[key]=(counts[key]??0)+1;
    return counts;
  },{}),
  duplicates,
},null,2));
