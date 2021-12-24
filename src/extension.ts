import { ExtensionContext } from "vscode";
import { createNotifier } from "./util";

export const [onExtensionActivated, activate] = createNotifier<ExtensionContext>();

import("./commands");
import("./views/treeView");
import("./workspace/credential");
import("./workspace/document");
import("./workspace/project");
import("./workspace/sync");
