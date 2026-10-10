package dev.termweave.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives PackageInstaller results. Not exported, so no other app can hand it an Intent to start. */
public final class InstallStatusReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Updater.ACTION_STATUS.equals(intent.getAction())) Updater.onStatus(context, intent);
    }
}
