package dev.termweave.companion;
import android.accessibilityservice.*;
import android.graphics.Path;
import android.view.accessibility.AccessibilityEvent;
import org.json.JSONObject;
public class InputService extends AccessibilityService  {
    static volatile InputService current;
    @Override protected void onServiceConnected() {
        current=this;
    }
    @Override public void onDestroy() {
        if(current==this)current=null;
        super.onDestroy();
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
    }
    @Override public void onInterrupt() {
    }
    void input(JSONObject o,int width,int height)throws Exception {
        if(!ProjectionService.sharing)return;
        String action=o.getString("action");
        if(action.equals("home")) {
            performGlobalAction(GLOBAL_ACTION_HOME);
            return;
        }
        if(action.equals("back")) {
            performGlobalAction(GLOBAL_ACTION_BACK);
            return;
        }
        if(!action.equals("tap")&&!action.equals("swipe"))return;
        double x=o.getDouble("x"),y=o.getDouble("y");
        if(!unit(x)||!unit(y))return;
        Path p=new Path();
        p.moveTo((float)(x*(width-1)),(float)(y*(height-1)));
        if(action.equals("swipe")) {
            double x2=o.getDouble("x2"),y2=o.getDouble("y2");
            if(!unit(x2)||!unit(y2))return;
            p.lineTo((float)(x2*(width-1)),(float)(y2*(height-1)));
        }
        dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p,0,action.equals("swipe")?250:40)).build(),null,null);
    }
    private boolean unit(double n) {
        return Double.isFinite(n)&&n>=0&&n<=1;
    }
}
