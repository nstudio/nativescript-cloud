import * as path from "path";
import * as semver from "semver";
import { CLOUD_BUILD_CONFIGURATIONS } from "../constants";
import { getProjectId } from "../helpers";
import { isInteractive } from "../helpers";

export class BuildCommandHelper implements IBuildCommandHelper {
	private shouldUseOldLocalBuildService = true;

	private get $localBuildService(): ILocalBuildService {
		if (this.shouldUseOldLocalBuildService) {
			return this.$injector.resolve("localBuildService");
		}

		return this.$injector.resolve("buildController");
	}

	constructor(private $nsCloudBuildService: ICloudBuildService,
		private $nsCloudErrorsService: IErrors,
		private $logger: ILogger,
		private $prompter: IPrompter,
		private $mobileHelper: Mobile.IMobileHelper,
		private $projectData: IProjectData,
		private $injector: IInjector,
		private $options: ICloudOptions,
		private $fs: IFileSystem,
		private $staticConfig: IStaticConfig) {
		this.$projectData.initializeProjectData();
		const cliVersion = this.$staticConfig.version;
		this.shouldUseOldLocalBuildService = semver.valid(cliVersion) && semver.lt(cliVersion, semver.prerelease(cliVersion) ? "5.4.0-2019-05-16-13277" : "6.0.0");
	}

	public async buildPlatform(platform: string, buildConfig: IBuildConfig, projectData: IProjectData): Promise<string> {
		const buildData = this.getCloudBuildData(platform);
		buildData.iOSBuildData.buildForDevice = buildConfig.buildForDevice;
		const buildResultData = await this.$nsCloudBuildService.build(buildData.projectSettings,
			buildData.platform, buildData.buildConfiguration,
			this.$options.accountId,
			buildData.androidBuildData,
			buildData.iOSBuildData);
		return buildResultData.outputFilePath;
	}

	public getCloudBuildData(platformArg: string): ICloudBuildData {
		const platform = this.$mobileHelper.validatePlatformName(platformArg);
		this.$logger.info(`Executing cloud build with platform: ${platform}.`);
		const nativescriptData = this.$fs.readJson(path.join(this.$projectData.projectDir, "package.json")).nativescript;
		let pathToCertificate = "";
		if (this.$mobileHelper.isAndroidPlatform(platform)) {
			pathToCertificate = this.$options.keyStorePath ? path.resolve(this.$options.keyStorePath) : "";
		} else if (this.$mobileHelper.isiOSPlatform(platform)) {
			pathToCertificate = this.$options.certificate ? path.resolve(this.$options.certificate) : "";
		} else {
			this.$nsCloudErrorsService.fail(`Currently only ${this.$mobileHelper.platformNames.join(' ')} platforms are supported.`);
		}

		const pathToProvision = this.$options.provision ? path.resolve(this.$options.provision) : "";
		const projectId = getProjectId(this.$projectData, platform.toLowerCase());
		const projectSettings: INSCloudProjectSettings = {
			nativescriptData,
			projectDir: this.$projectData.projectDir,
			projectId,
			projectName: this.$projectData.projectName,
			bundle: !!this.$options.bundle,
			sharedCloud: this.$options.sharedCloud,
			flavorId: this.$options.vmTemplateName,
			workflowName: this.$options.workflow && this.$options.workflow.name,
			workflowUrl: this.$options.workflow && this.$options.workflow.url,
			clean: this.$options.clean,
			env: this.$options.env,
			useHotModuleReload: this.$options.hmr
		};

		const buildConfiguration = this.$options.release ? CLOUD_BUILD_CONFIGURATIONS.RELEASE : CLOUD_BUILD_CONFIGURATIONS.DEBUG;
		return {
			projectSettings,
			platform,
			buildConfiguration,
			androidBuildData: <any>{
				pathToCertificate,
				certificatePassword: this.$options.keyStorePassword,
				aab: this.$options.aab
			},
			iOSBuildData: {
				pathToCertificate,
				certificatePassword: this.$options.certificatePassword,
				pathToProvision,
				buildForDevice: !this.$options.emulator
			}
		};
	}

	public async getAppleCredentials(args: string[]): Promise<ICredentials> {
		let { username, password } = this.getUsernameAndPasswordFromArgs(args);

		if (!username) {
			username = await this.$prompter.getString("Apple ID", { allowEmpty: false });
		}

		if (!password) {
			password = await this.$prompter.getPassword("Apple ID password");
		}

		return {
			username,
			password
		};
	}

	public async getExtendedAppleCredentials(args: string[], options: ICloudOptions): Promise<IPublishCredentials> {
		const extendedCredentials = {
			appleApplicationSpecificPassword: options.appleApplicationSpecificPassword,
			appleSession: options.appleSessionBase64 ? Buffer.from(options.appleSessionBase64, "base64").toString() : undefined
		};

		let credentials: ICredentials;
		if (!options.appleSessionBase64) {
			credentials = await this.getAppleCredentials(args);
		} else {
			credentials = this.getUsernameAndPasswordFromArgs(args);
			if (!isInteractive() && (!credentials.username || !credentials.password)) {
				// We are in the CI/CD scenario but we don't have all credentials.
				this.$nsCloudErrorsService.fail("Please provide Apple ID and Apple ID password");
			}
		}

		return _.merge(credentials, extendedCredentials);
	}

	public async buildForPublishingPlatform(platformArg: string): Promise<string> {
		let packagePath: string;
		const platform = this.$mobileHelper.validatePlatformName(platformArg);
		if (this.$options.local) {
			packagePath = await this.executeLocalBuild(platform);
		} else {
			const buildData = this.getCloudBuildData(platform);
			buildData.buildConfiguration = CLOUD_BUILD_CONFIGURATIONS.RELEASE;
			const cloudResult = await this.$nsCloudBuildService.build(buildData.projectSettings,
				buildData.platform, buildData.buildConfiguration,
				this.$options.accountId,
				buildData.androidBuildData,
				buildData.iOSBuildData,
				{ shouldPrepare: true });

			packagePath = cloudResult.qrData ? cloudResult.qrData.originalUrl : cloudResult.outputFilePath;
		}

		return packagePath;
	}

	private getUsernameAndPasswordFromArgs(args: string[]): ICredentials {
		return { username: args[0], password: args[1] };
	}

	private async executeLocalBuild(platform: string): Promise<string> {
		let packagePath: string = null;

		if (this.shouldUseOldLocalBuildService) {
			packagePath = await this.$localBuildService.build(platform, {
				release: true,
				buildForDevice: true,
				clean: this.$options.clean,
				teamId: this.$options.teamId,
				bundle: !!this.$options.bundle,
				device: this.$options.device,
				projectDir: this.$options.path,
				provision: this.$options.provision,
				keyStoreAlias: this.$options.keyStoreAlias,
				keyStoreAliasPassword: this.$options.keyStoreAliasPassword,
				keyStorePassword: this.$options.keyStorePassword,
				keyStorePath: this.$options.keyStorePath,
				useHotModuleReload: this.$options.hmr,
				env: this.$options.env,
				iCloudContainerEnvironment: this.$options.iCloudContainerEnvironment
			}, (<any>this.$options).platformTemplate);
		} else {
			const $buildDataService = this.$injector.resolve("buildDataService");
			const buildData = $buildDataService.getBuildData(this.$projectData.projectDir, platform, this.$options);
			packagePath = await this.$localBuildService.build(buildData);
		}

		return packagePath;
	}
}

$injector.register("nsCloudBuildCommandHelper", BuildCommandHelper);
