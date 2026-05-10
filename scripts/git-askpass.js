#!/usr/bin/env node

const prompt = process.argv.slice(2).join(" ").toLowerCase();

if (prompt.includes("username")) {
  process.stdout.write(process.env.GIT_USERNAME || "x-access-token");
} else {
  process.stdout.write(process.env.GIT_PASSWORD || "");
}
