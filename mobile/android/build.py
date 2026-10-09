#!/usr/bin/env python3
"""Build without changing shell, SDK, Java, or agent configuration."""
import os,pathlib,shutil,subprocess,sys
root=pathlib.Path(__file__).resolve().parent;env=os.environ.copy()
if not env.get('JAVA_HOME'):
    candidates=[pathlib.Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')]
    found=next((p for p in candidates if (p/'bin/java').is_file()),None)
    if found:env['JAVA_HOME']=str(found)
if not env.get('ANDROID_HOME'):env['ANDROID_HOME']=str(pathlib.Path.home()/'Library/Android/sdk')
gradle=os.environ.get('TERMWEAVE_GRADLE') or shutil.which('gradle')
if not gradle:
    candidates=sorted((pathlib.Path.home()/'.gradle/wrapper/dists/gradle-8.9-bin').glob('*/gradle-8.9/bin/gradle'))
    if candidates:gradle=str(candidates[0])
if not gradle:raise SystemExit('Gradle 8.9 is required. Set TERMWEAVE_GRADLE to its executable.')
raise SystemExit(subprocess.call([gradle,'--no-daemon',*(sys.argv[1:] or [':app:assembleDebug',':app:lintDebug'])],cwd=root,env=env))
