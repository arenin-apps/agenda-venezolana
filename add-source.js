// add-source.js
// Se dispara desde el workflow "Agregar fuente" (Actions -> Run workflow).
// Agrega una fuente nueva a sources.json sin que haga falta tocar código.

const fs = require("fs");
const { readSources, SOURCES_PATH } = require("./events-utils");

const name = process.env.SOURCE_NAME;
const url = process.env.SOURCE_URL;
const useRenderProxy = process.env.USE_RENDER_PROXY === "true";

if (!name || !name.trim()) {
  console.error("❌ ERROR: Falta el nombre de la fuente.");
  process.exit(1);
}
if (!url || !url.trim()) {
  console.error("❌ ERROR: Falta la URL de la fuente.");
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(url.trim());
} catch (err) {
  console.error(`❌ ERROR: "${url}" no es una URL válida (¿te falta el https://?).`);
  process.exit(1);
}

const sources = readSources();

const alreadyExists = sources.some(
  (s) =>
    s.url === parsedUrl.href ||
    s.name.trim().toLowerCase() === name.trim().toLowerCase()
);

if (alreadyExists) {
  console.log(`ℹ️ Ya existe una fuente con ese nombre o esa URL. No se agregó nada.`);
  console.log(`   Fuentes actuales: ${sources.length}`);
  process.exit(0);
}

const newSource = { name: name.trim(), url: parsedUrl.href };
if (useRenderProxy) newSource.useRenderProxy = true;

sources.push(newSource);
fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2), "utf-8");

console.log(`🎉 Fuente agregada: "${newSource.name}" → ${newSource.url}`);
console.log(`📚 Total de fuentes ahora: ${sources.length}`);
console.log(
  `ℹ️ Se va a rastrear a partir de la próxima corrida del scraper diario (o corrélo manualmente vos mismo para probarla ya).`
);
