const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const fs = require('fs').promises;
const path = require('path');

/**
 * Run a command with timeout using macOS native timeout (gtimeout from coreutils)
 */
async function execWithTimeout(command, args, options = {}) {
    const {cwd, timeoutSeconds} = options;
    
    console.log(`Running: ${command} ${args.join(' ')}`);
    console.log(`Timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes (${(timeoutSeconds / 3600).toFixed(2)} hours)`);
    
    // Use gtimeout from coreutils (brew install coreutils)
    const timeoutArgs = [
        '-k', '5m',
        '-s', 'INT',
        `${timeoutSeconds}s`,
        command,
        ...args
    ];
    
    const exitCode = await exec.exec('gtimeout', timeoutArgs, {
        cwd: cwd,
        ignoreReturnCode: true
    });
    
    if (exitCode === 124) {
        console.log(`⏱️ Timeout reached after ${(timeoutSeconds / 60).toFixed(0)} minutes`);
    }
    
    return exitCode;
}

async function run() {
    process.on('SIGINT', function() {});
    
    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    
    const versionFile = path.join(process.env.GITHUB_WORKSPACE, 'brave_version.txt');
    let brave_version = '';
    try {
        brave_version = (await fs.readFile(versionFile, 'utf-8')).trim();
        console.log(`Building Brave version: ${brave_version} (from brave_version.txt)`);
    } catch (e) {
        core.setFailed(`Failed to read brave_version.txt: ${e.message}`);
        return;
    }
    
    console.log(`finished: ${finished}, from_artifact: ${from_artifact}`);
    
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    const artifactName = 'build-artifact';
    const workDir = path.join(process.env.HOME, 'brave-build');
    const srcDir = path.join(workDir, 'src');
    const braveDir = path.join(srcDir, 'brave');

    // Install GNU tar and coreutils on EVERY job (fresh runner each time)
    console.log('Installing build dependencies via Homebrew...');
    await exec.exec('brew', ['install', 'coreutils', 'gnu-tar'], {ignoreReturnCode: true});
    
    // Install Metal toolchain for Xcode 26.0+
    console.log('Installing Metal toolchain...');
    await exec.exec('xcodebuild', ['-downloadComponent', 'MetalToolchain'], {ignoreReturnCode: true});

    try {
        await io.mkdirP(srcDir);
    } catch (e) {
        console.log('Work directory already exists');
    }

    if (from_artifact) {
        console.log('Downloading previous build artifact...');
        try {
            const downloadPath = path.join(workDir, 'artifact');
            await io.mkdirP(downloadPath);
            
            const artifactInfo = await artifact.getArtifact(artifactName);
            await artifact.downloadArtifact(artifactInfo.artifact.id, {path: downloadPath});
            
            console.log('Extracting build state...');
            const archivePath = path.join(downloadPath, 'build-state.tar.zst');
            // Use gtar (GNU tar from brew install gnu-tar)
            await exec.exec('sudo', ['gtar', 'xf', archivePath, '-C', workDir]);
            
            await io.rmRF(downloadPath);

            console.log('Installing npm dependencies...');
            await exec.exec('npm', ['ci'], {
                cwd: braveDir,
                ignoreReturnCode: true
            });
        } catch (e) {
            console.error(`Failed to download artifact: ${e}`);
            throw e;
        }
    } else {
        console.log('Initializing Brave build environment...');
        
        core.exportVariable('PYTHONUNBUFFERED', '1');
        core.exportVariable('GSUTIL_ENABLE_LUCI_AUTH', '0');

        const braveTag = brave_version.startsWith('v') ? brave_version : `v${brave_version}`;
        console.log(`Cloning brave-core tag ${braveTag} to ${braveDir}...`);
        await exec.exec('git', ['clone', '--branch', braveTag, '--depth=2',
            'https://github.com/brave/brave-core.git', braveDir], {
            ignoreReturnCode: true
        });

        console.log('Installing npm dependencies...');
        await exec.exec('npm', ['install'], {
            cwd: braveDir,
            ignoreReturnCode: true
        });
    }

    const markerFile = path.join(workDir, 'build-stage.txt');
    let currentStage = 'init';
    
    try {
        const markerContent = await fs.readFile(markerFile, 'utf-8');
        currentStage = markerContent.trim();
        console.log(`Resuming from stage: ${currentStage}`);
    } catch (e) {
        console.log('Starting from init stage');
    }

    let buildSuccess = false;
    const JOB_START_TIME = Date.now();
    const MAX_JOB_TIME = 270 * 60 * 1000; // 4.5 hours

    try {
        // Stage 1: npm run init
        if (currentStage === 'init') {
            console.log('=== Stage: npm run init ===');
            console.log('Running npm run init with --no-history...');
            
            const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
                cwd: braveDir,
                ignoreReturnCode: true
            });
            
            if (initCode === 0) {
                console.log('✓ npm run init completed successfully');
                await fs.writeFile(markerFile, 'build');
                currentStage = 'build';
            } else {
                console.log(`✗ npm run init failed with code ${initCode}`);
            }
        }

        // Stage 2: npm run build
        if (currentStage === 'build') {
            const elapsedTime = Date.now() - JOB_START_TIME;
            let remainingTime = MAX_JOB_TIME - elapsedTime;
            // temporary to test if builds are resumed correctly
            remainingTime = 11*60*1000
            
            console.log('=== Stage: npm run build ===');
            console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
            console.log(`Remaining time calculated: ${(remainingTime / 3600000).toFixed(2)} hours`);
            
            const MIN_TIMEOUT = 10 * 60 * 1000;
            remainingTime = Math.max(remainingTime, MIN_TIMEOUT);
            
            const timeoutSeconds = Math.floor(remainingTime / 1000);
            console.log(`Final timeout: ${(timeoutSeconds / 60).toFixed(0)} minutes`);
            console.log('Running npm run build (Component build)...');
            
            const buildCode = await execWithTimeout('npm', ['run', 'build'], {
                cwd: braveDir,
                timeoutSeconds: timeoutSeconds
            });
            
            if (buildCode === 0) {
                console.log('✓ npm run build completed successfully');
                await fs.writeFile(markerFile, 'package');
                currentStage = 'package';
                buildSuccess = true;
            } else if (buildCode === 124) {
                console.log('⏱️ npm run build timed out - will resume in next stage');
                
                console.log('Waiting 30 seconds for build processes to finish cleanup...');
                await new Promise(r => setTimeout(r, 30000));
                
                console.log('Syncing filesystem after timeout...');
                await exec.exec('sync', [], {ignoreReturnCode: true});
            } else {
                console.log(`✗ npm run build failed with code ${buildCode}`);
            }
        }

    } catch (e) {
        console.error(`Build error: ${e.message}`);
    }

    if (buildSuccess && currentStage === 'package') {
        console.log('Build completed successfully, packaging artifacts...');
        
        const outDir = path.join(srcDir, 'out');
        
        try {
            await fs.access(outDir);
            console.log(`Found out directory at ${outDir}`);
            
            // Archive the entire out directory for debugging
            const packageName = `brave-out-${brave_version}-macos.tar.xz`;
            const packagePath = path.join(workDir, packageName);
            
            console.log(`Creating archive of entire out directory: ${packageName}`);
            console.log('This may take a while...');
            await exec.exec('gtar', ['caf', packagePath,
                '-H', 'posix',
                '--atime-preserve', 
                '-C', srcDir, 'out'],
                {ignoreReturnCode: true});
            
            const packageList = [packagePath];
            
            for (let i = 0; i < 5; ++i) {
                try {
                    await artifact.deleteArtifact('brave-browser-macos');
                } catch (e) {}
                try {
                    await artifact.uploadArtifact('brave-browser-macos', packageList, workDir, 
                        {retentionDays: 7, compressionLevel: 0});
                    console.log('Successfully uploaded final artifact');
                    break;
                } catch (e) {
                    console.error(`Upload artifact failed: ${e}`);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
            
            core.setOutput('finished', true);
        } catch (e) {
            console.error(`Package creation failed: ${e.message}`);
            buildSuccess = false;
        }
    }
    
    if (!buildSuccess) {
        console.log('Build incomplete, creating checkpoint artifact...');
        
        await new Promise(r => setTimeout(r, 5000));
        
        console.log('Syncing filesystem to flush all writes...');
        await exec.exec('sync', [], {ignoreReturnCode: true});
        await exec.exec('sync', [], {ignoreReturnCode: true});
        
        const stateArchive = path.join(workDir, 'build-state.tar.zst');
        
        console.log('Archiving build state with gtar...');
        // Use gtar with POSIX format and atime preservation (like Linux)
        await exec.exec('gtar', ['caf', stateArchive,
            '-H', 'posix',
            '--atime-preserve',
            '-C', workDir,
            'src', 'build-stage.txt'], 
            {ignoreReturnCode: true});

        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(artifactName);
            } catch (e) {}
            try {
                await artifact.uploadArtifact(artifactName, [stateArchive], workDir, 
                    {retentionDays: 1, compressionLevel: 0});
                console.log('Successfully uploaded checkpoint artifact');
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));

