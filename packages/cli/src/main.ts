#!/usr/bin/env node
import vm from "node:vm";
import { agentToolScript } from "./script.js";

vm.runInThisContext(agentToolScript().replace(/^#![^\n]*\n/, ""), { filename: "aisevak" });
