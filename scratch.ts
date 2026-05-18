import { hashPassword } from "./src/lib/auth/password";
import fs from "fs";

const hash = hashPassword("1");
const settingsPath = "./data/settings/settings.json";
const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
data.auth.passwordHash = hash;
data.auth.enabled = true; // re-enable it
fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
console.log("Password reset to: 1");
