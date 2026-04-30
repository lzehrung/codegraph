import { login } from "@complex/core-logic";
import type { User } from "@complex/shared-types";
import { getRuntimeInfo } from "@complex/utils/runtime";
import { login as shadowedLogin } from "@complex/shadowed";
import React from "react";

async function startApp() {
  const runtime = getRuntimeInfo();
  console.log("Runtime:", runtime);

  const user: User = login("admin");
  console.log("User logged in:", user);

  // Dynamic import
  const { log } = await import("./plugins/logger");
  log("App started");
}

startApp();
