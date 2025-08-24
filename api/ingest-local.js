import fetch from "node-fetch";
import fs from "fs";

const markdown = fs.readFileSync("./assistant-knowledge.txt", "utf8");
const res = await fetch("http://localhost:3000/api/admin/ingest", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Manual Linje 65", markdown, setActive: true })
});
console.log(await res.json());
