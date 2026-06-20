const fs   = require("fs");
const path = require("path");

const INPUT_FILE  = process.argv[2] || "farmers_export_KPMD 2_2026-05-27.csv";
const OUTPUT_FILE = process.argv[3] || "kpmd.json";

const raw   = fs.readFileSync(INPUT_FILE, "utf8");
const lines = raw.trim().split("\n");

// Parse CSV line respecting quoted fields
const parseLine = (line) => {
  const result = [];
  let current  = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
};

const headers = parseLine(lines[0]);
const output  = {};

// Generate a Firebase-like push ID
const generatePushId = () => {
  const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  let id           = "";
  let now          = Date.now();
  for (let i = 7; i >= 0; i--) {
    id = PUSH_CHARS[now % 64] + id;
    now = Math.floor(now / 64);
  }
  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS[Math.floor(Math.random() * 64)];
  }
  return "-" + id;
};

// Format date from MM/DD/YYYY to "DD Mon YYYY"
const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts  = dateStr.split("/");
  if (parts.length !== 3) return dateStr;
  const month = months[parseInt(parts[0]) - 1];
  const day   = parts[1].padStart(2, "0");
  const year  = parts[2];
  return `${day} ${month} ${year}`;
};

for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;

  const values = parseLine(lines[i]);
  const row    = {};
  headers.forEach((h, idx) => { row[h] = values[idx] || ""; });

  const key = generatePushId();

  const vaccines = row["Vaccines"] && row["Vaccines"].trim() !== ""
    ? row["Vaccines"].split(";").map(v => v.trim()).filter(Boolean)
    : [];

  output[key] = {
    ageDistribution: {
      "1-4": parseInt(row["Age 1-4"]) || 0,
      "5-8": parseInt(row["Age 5-8"]) || 0,
      "8+":  parseInt(row["Age 8+"])  || 0,
    },
    aggregationGroup: row["Aggregation Group"] || "",
    bucksServed:      row["Bucks Served"]       || "0",
    cattle:           row["Cattle"]             || "0",
    county:           row["County"]             || "",
    createdAt:        Date.now(),
    farmerId:         row["Farmer ID"]          || "",
    femaleBreeds:     row["Female Breeds"]      || "0",
    gender:           row["Gender"]             || "",
    goats: {
      female: parseInt(row["Goats (Female)"]) || 0,
      male:   parseInt(row["Goats (Male)"])   || 0,
      total:  parseInt(row["Goats (Total)"])  || 0,
    },
    idNumber:         row["ID Number"]          || "",
    location:         row["Location"]           || "",
    maleBreeds:       row["Male Breeds"]        || "0",
    name:             row["Name"]               || "",
    phone:            row["Phone"]              || "",
    programme:        row["Programme"]          || "",
    registrationDate: formatDate(row["Registration Date"]),
    sheep:            row["Sheep"]              || "0",
    subcounty:        row["Subcounty"]          || "",
    traceability:     row["Traceability"]?.toLowerCase() === "yes",
    username:         row["Field Officer"]      || "",
    vaccinated:       row["Vaccinated"]?.toLowerCase() === "yes",
    ...(vaccines.length > 0 && { vaccines }),
    ...(row["Vaccination Date"] && row["Vaccination Date"].trim() !== "" && { vaccinationDate: row["Vaccination Date"] }),
    ...(row["Dewormed"]?.toLowerCase() === "yes" && { dewormed: true }),
    ...(row["Deworming Date"] && row["Deworming Date"].trim() !== "" && { dewormingDate: row["Deworming Date"] }),
  };
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

console.log(`Done! ${Object.keys(output).length} records written to ${OUTPUT_FILE}`);
