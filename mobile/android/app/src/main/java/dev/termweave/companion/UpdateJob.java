package dev.termweave.companion;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Background update check; posts a notification when the relay serves a newer APK. */
public class UpdateJob extends JobService {
    @Override public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try { Updater.Latest latest = Updater.newer(this); if (latest != null) Updater.notify(this, latest); } catch (Exception ignored) { /* retried next period */ }
            jobFinished(params, false);
        }).start();
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { return true; }
}
