import "path";
import { exit } from "process";
import { exec } from "./exec";
import path from "path";
import { watch as chokidar } from "chokidar";

type PluginName = "make";
const PLUGIN_NAME: PluginName = "make";

type PluginConfig = {
  target?: string; // Default is "", which will run "_PHONY" target
  makefile?: string; // Default is "./Makefile"
  reloadHandler?: boolean; // Default is false
  watch?: string[]; // Default is []
};

type ServerlessCustom = {
  make?: PluginConfig;
  "serverless-offline"?: {
    location?: string;
  };
};

type ServerlessService = {
  service: string;
  custom?: ServerlessCustom;
  provider: {
    stage: string;
    environment?: { [key: string]: string | { Ref?: string } };
  };
  getAllFunctions: () => string[];
  getFunction: (functionName: string) => {
    name: string;
    events?: any[];
  };
};

type ServerlessConfig = {
  servicePath: string;
};

type Serverless = {
  service: ServerlessService;
  pluginManager: {
    spawn: (command: string) => Promise<void>;
  };
  config: any;
};

type Options = {
  verbose?: boolean;
  log?: ServerlessLog;
};

type ServerlessLog = ((message: string) => void) & {
  verbose: (message: string) => void;
  warning: (message: string) => void;
  error: (message: string) => void;
};

class Log {
  constructor(private options: Options) {}

  static msg = (message: string) => {
    return `[${PLUGIN_NAME}] ${message}`;
  };

  log = (message: string) => {
    if (this.options.log) {
      this.options.log(Log.msg(message));
    } else {
      console.log(Log.msg(message));
    }
  };

  verbose = (message: string) => {
    if (this.options.log) {
      this.options.log.verbose(Log.msg(message));
    }
  };

  warning = (message: string) => {
    if (this.options.log) {
      this.options.log.warning(Log.msg(message));
    } else {
      console.warn(Log.msg(message));
    }
  };

  error = (message: string) => {
    if (this.options.log) {
      this.options.log.error(Log.msg(message));
    } else {
      console.error(Log.msg(message));
    }
  };
}

class ServerlessMake {
  log: Log;

  serverless: Serverless;
  serverlessConfig: ServerlessConfig;
  pluginConfig: PluginConfig;

  hooks: {
    [key: string]: () => Promise<void>;
  };

  constructor(serverless: Serverless, protected options: Options) {
    this.serverless = serverless;
    this.serverlessConfig = serverless.config;
    this.pluginConfig =
      (this.serverless.service.custom &&
        this.serverless.service.custom[PLUGIN_NAME]) ||
      {};

    this.log = new Log(options);

    this.hooks = {
      initialize: async () => {},
      "before:offline:start": async () => {
        this.log.verbose("before:offline:start");
        let errored = false;
        try {
          await this.build(this.pluginConfig.reloadHandler);
        } catch (e) {
          errored = true;
          if (e instanceof Error) {
            this.log.error(e.message);
          }
        } finally {
          if (errored) {
            exit(1);
          }
        }
      },
      "before:package:createDeploymentArtifacts": async () => {
        this.log.verbose("before:package:createDeploymentArtifacts");
        let errored = false;
        try {
          await this.build(false);
        } catch (e) {
          errored = true;
          if (e instanceof Error) {
            this.log.error(e.message);
          }
          throw e;
        } finally {
          if (errored) {
            exit(1);
          }
        }
      },
    };
  }

  build = async (watch?: boolean): Promise<void> => {
    const makefile = path.join(
      this.serverlessConfig.servicePath,
      this.pluginConfig.makefile || "./Makefile"
    );
    const workdir = path.dirname(makefile);
    const target = this.pluginConfig.target || "";

    const command = ["make", "-f", makefile, target];

    // TODO: pull in envrionment variables from serverless.yml
    await exec(command, workdir, this.log.verbose);

    if (watch) {
      const paths = [
        ...[makefile],
        ...(this.pluginConfig.watch || []).map((p) =>
          path.join(this.serverlessConfig.servicePath, p)
        ),
      ];

      this.log.log(
        `Watching for changes in:\n${paths.map((p) => ` - ${p}`).join(`\n`)}`
      );

      chokidar(paths, {
        ignoreInitial: true,
        usePolling: true,
        interval: 100,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      }).on("all", async () => {
        this.log.log("Change detected, rebuilding...");
        try {
          await this.build(false);
        } catch (e) {
          if (e instanceof Error) {
            this.log.error(e.message);
          }
        }
      });
    }

    // TODO: emit an event to the serverless framework
    this.log.log("Build complete");
  };
}

module.exports = ServerlessMake;
