package dev.termweave.companion;
import android.app.*;
import android.content.*;
import android.os.*;
import android.graphics.*;
import android.media.*;
import android.media.projection.*;
import android.hardware.display.*;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.content.res.Configuration;
import okhttp3.*;
import okio.ByteString;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.TimeUnit;
public class ProjectionService extends Service  {
    static volatile boolean sharing=false;
    private final Handler main=new Handler(Looper.getMainLooper());
    private HandlerThread worker;
    private Handler capture;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private WebSocket socket;
    private OkHttpClient client;
    private volatile String streamId="";
    private volatile boolean paired=false;
    private long lastSeq=0,lastFrame=0;
    private int physicalWidth,physicalHeight,frameWidth,frameHeight;
    private boolean stopping=false;
    @Override public IBinder onBind(Intent i) {
        return null;
    }
    @Override public int onStartCommand(Intent intent,int flags,int id) {
        if(intent==null||"stop".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if(projection!=null) {
            return START_NOT_STICKY;
        }
        NotificationManager nm=getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("sharing","화면 공유",NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop=PendingIntent.getService(this,0,new Intent(this,ProjectionService.class).setAction("stop"),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Notification note=new Notification.Builder(this,"sharing").setSmallIcon(android.R.drawable.ic_menu_view).setContentTitle("TermWeave 화면 공유 중").setContentText("알림의 종료 버튼으로 화면과 입력 연결을 해제합니다.").setOngoing(true).addAction(new Notification.Action.Builder(null,"공유 종료",stop).build()).build();
        startForeground(41,note,android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        try {
            Intent consent=intent.getParcelableExtra("consent");
            String endpoint=intent.getStringExtra("endpoint"),token=intent.getStringExtra("token");
            intent.removeExtra("token");
            if(consent==null||endpoint==null||token==null)throw new IllegalArgumentException();
            DisplayMetrics metrics=new DisplayMetrics();
            getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
            physicalWidth=metrics.widthPixels;
            physicalHeight=metrics.heightPixels;
            frameWidth=Math.min(720,physicalWidth);
            frameHeight=Math.max(1,Math.round((float)physicalHeight*frameWidth/physicalWidth));
            worker=new HandlerThread("termweave-capture");
            worker.start();
            capture=new Handler(worker.getLooper());
            projection=getSystemService(MediaProjectionManager.class).getMediaProjection(Activity.RESULT_OK,consent);
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() {
                    main.post(()->stopSelf());
                }
                @Override public void onCapturedContentResize(int w,int h) {
                    if(w!=physicalWidth||h!=physicalHeight)main.post(()->stopSelf());
                }
            }
            ,main);
            reader=ImageReader.newInstance(frameWidth,frameHeight,PixelFormat.RGBA_8888,2);
            reader.setOnImageAvailableListener(this::frame,capture);
            display=projection.createVirtualDisplay("TermWeave",frameWidth,frameHeight,metrics.densityDpi,DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,reader.getSurface(),null,capture);
            sharing=true;
            client=new OkHttpClient.Builder().pingInterval(10,TimeUnit.SECONDS).callTimeout(0,TimeUnit.SECONDS).build();
            socket=client.newWebSocket(new Request.Builder().url(endpoint).header("Authorization","Bearer "+token).build(),new WebSocketListener() {
                @Override public void onMessage(WebSocket ws,String text) {
                    if(text.length()>4096)return;
                    main.post(()->message(text));
                }
                @Override public void onFailure(WebSocket ws,Throwable e,Response r) {
                    main.post(()->stopSelf());
                }
                @Override public void onClosed(WebSocket ws,int code,String reason) {
                    main.post(()->stopSelf());
                }
                @Override public void onClosing(WebSocket ws,int code,String reason) {
                    ws.close(code,null);
                    main.post(()->stopSelf());
                }
            }
            );
        }
        catch(Exception e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }
    private void message(String text) {
        if(!sharing)return;
        try {
            JSONObject o=new JSONObject(text);
            String type=o.optString("type");
            if(type.equals("session")) {
                boolean connected=o.optBoolean("connected");
                if(paired&&!connected) {
                    stopSelf();
                    return;
                }
                paired=connected;
                streamId=o.getString("streamId");
                lastSeq=0;
                if(socket!=null)socket.send(new JSONObject().put("type","status").put("sharing",true).put("inputAllowed",InputService.current!=null).toString());
                return;
            }
            if(!type.equals("input")||!paired||!streamId.equals(o.optString("streamId")))return;
            long seq=o.getLong("seq"),expiry=o.getLong("expiresAt"),now=System.currentTimeMillis();
            if(seq<=lastSeq||expiry<now||expiry>now+2000)return;
            lastSeq=seq;
            InputService input=InputService.current;
            if(input!=null)input.input(o,physicalWidth,physicalHeight);
        }
        catch(Exception ignored) {
        }
    }
    private void frame(ImageReader r) {
        try(Image image=r.acquireLatestImage()) {
            if(image==null||!sharing||!paired||socket==null||socket.queueSize()>262144||SystemClock.elapsedRealtime()-lastFrame<200)return;
            lastFrame=SystemClock.elapsedRealtime();
            Image.Plane plane=image.getPlanes()[0];
            int padded=plane.getRowStride()/plane.getPixelStride();
            Bitmap full=Bitmap.createBitmap(padded,frameHeight,Bitmap.Config.ARGB_8888);
            full.copyPixelsFromBuffer(plane.getBuffer());
            Bitmap crop=Bitmap.createBitmap(full,0,0,frameWidth,frameHeight);
            ByteArrayOutputStream out=new ByteArrayOutputStream();
            crop.compress(Bitmap.CompressFormat.JPEG,55,out);
            if(crop!=full)crop.recycle();
            full.recycle();
            byte[] jpeg=out.toByteArray();
            if(jpeg.length<=1048576&&sharing&&paired)socket.send(ByteString.of(jpeg));
        }
        catch(Exception ignored) {
            main.post(()->stopSelf());
        }
    }
    @Override public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if(sharing)stopSelf();
    }
    @Override public void onDestroy() {
        if(stopping)return;
        stopping=true;
        sharing=false;
        paired=false;
        streamId="";
        if(socket!=null) {
            socket.close(1000,"Sharing stopped");
            socket.cancel();
            socket=null;
        }
        if(display!=null)display.release();
        if(reader!=null) {
            reader.setOnImageAvailableListener(null,null);
            reader.close();
        }
        if(projection!=null) {
            projection.stop();
            projection=null;
        }
        if(worker!=null)worker.quitSafely();
        if(client!=null)client.dispatcher().executorService().shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
