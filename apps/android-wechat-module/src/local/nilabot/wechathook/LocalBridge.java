package local.nilabot.wechathook;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Base64;
import android.graphics.BitmapFactory;
import android.graphics.Bitmap;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.ZipFile;

/** Local transport: independently allowlisted groups and private link requests. */
public final class LocalBridge {
    private static volatile LocalBridge active;
    private final ClassLoader loader;
    private final String token;
    private final String generation = UUID.randomUUID().toString();
    private final long started = System.currentTimeMillis();
    private final Map<String,Object> databases = new ConcurrentHashMap<>();
    private volatile Map<String,String> groups = Collections.emptyMap();
    private final List<JSONObject> events = new ArrayList<>();
    private volatile long sequence = 0;
    private final TextSendLedger textSends;
    private final ThreadLocal<Boolean> ownQuery = new ThreadLocal<>();
    private final Map<String,String> names = new LinkedHashMap<>();
    private final SharedPreferences registrationStore;
    private final SharedPreferences imageStore;
    private final File imageDirectory;
    private final Map<String,JSONObject> registrations = new LinkedHashMap<>();
    private volatile Set<String> authorized = Collections.emptySet();
    private volatile Set<String> privateAuthorized = Collections.emptySet();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile String pendingGroup;
    private volatile JSONObject networkResult;

    public static synchronized void start(Context context, ClassLoader loader, Class<?> database, String modulePath) {
        if (active != null) return;
        try {
            if (modulePath == null) throw new IllegalStateException("module_path_missing");
            JSONObject config;
            try (ZipFile zip = new ZipFile(modulePath); InputStream input = zip.getInputStream(zip.getEntry("assets/nila-config.json"))) {
                config = new JSONObject(readSmall(input, 8192));
            }
            if (!config.optBoolean("enabled", false)) return;
            LocalBridge bridge = new LocalBridge(context, loader, config);
            bridge.hook(database);
            ServerSocket server = new ServerSocket();
            server.bind(new InetSocketAddress("127.0.0.1", 8767), 8);
            active = bridge;
            Thread worker = new Thread(() -> bridge.serve(server), "NilaLocalApi");
            worker.setDaemon(true); worker.start();
            Log.i("NilaWeChatHook", "local_api_ready:127.0.0.1:8767:authenticated");
        } catch (Throwable error) {
            Log.w("NilaWeChatHook", "local_api_start_failed:" + error.getClass().getSimpleName());
        }
    }

    private LocalBridge(Context context, ClassLoader loader, JSONObject config) throws Exception {
        this.loader = loader;
        this.textSends=new TextSendLedger(new File(context.getFilesDir(),"nila-text-sends-v1"));
        this.registrationStore=context.getSharedPreferences("nila_group_requests_v1",Context.MODE_PRIVATE);
        this.imageStore=context.getSharedPreferences("nila_image_sends_v1",Context.MODE_PRIVATE);
        this.imageDirectory=new File(context.getFilesDir(),"nila-generated-images");
        if(!imageDirectory.isDirectory()&&!imageDirectory.mkdirs())throw new IOException("image_directory");
        File[] oldImages=imageDirectory.listFiles();
        if(oldImages!=null)for(File file:oldImages)if(file.isFile()&&System.currentTimeMillis()-file.lastModified()>7L*86400000)file.delete();
        this.token = config.getString("token");
        if (!token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("token");
        JSONArray allowed = config.getJSONArray("groups");
        for (int i=0; i<allowed.length(); i++) {
            JSONObject item = allowed.getJSONObject(i);
            String name = item.getString("name"); names.put(name, name);
            JSONArray aliases = item.optJSONArray("aliases");
            if (aliases != null) for (int j=0; j<aliases.length(); j++) names.put(aliases.getString(j), name);
        }
        JSONArray saved=new JSONArray(registrationStore.getString("requests","[]"));
        for(int i=0;i<saved.length()&&i<198;i++){
            JSONObject item=saved.getJSONObject(i);String id=item.getString("chat_id");
            if(id.matches("[A-Za-z0-9_\\-]+@chatroom"))registrations.put(id,item);
        }
    }

    private void hook(Class<?> database) {
        try {
            Class<?> scene=Class.forName("f61.s0",false,loader);
            XposedBridge.hookAllMethods(scene,"onGYNetEnd",new XC_MethodHook(){
                @Override protected void beforeHookedMethod(MethodHookParam p) {
                    try {
                        if(pendingGroup==null)return;
                        List<?> messages=(List<?>)XposedHelpers.getObjectField(p.thisObject,"i");
                        List<Integer> positions=new ArrayList<>();
                        for(int i=0;i<messages.size();i++)if(pendingGroup.equals(XposedHelpers.callMethod(messages.get(i),"N0")))positions.add(i);
                        if(positions.isEmpty())return;
                        JSONObject report=new JSONObject().put("error_type",p.args[1]).put("error_code",p.args[2]);
                        try {
                            Object wrapper=XposedHelpers.getObjectField(p.thisObject,"e");
                            Object response=XposedHelpers.getObjectField(XposedHelpers.getObjectField(wrapper,"b"),"a");
                            List<?> items=(List<?>)XposedHelpers.getObjectField(response,"e");
                            JSONArray codes=new JSONArray();
                            for(Integer index:positions)if(index<items.size())codes.put(XposedHelpers.getIntField(items.get(index),"d"));
                            report.put("item_codes",codes);
                        }catch(Throwable ignored) { }
                        networkResult=report;
                    }catch(Throwable ignored) { }
                }
            });
        }catch(Throwable error){Log.w("NilaWeChatHook","send_result_hook_unavailable:"+error.getClass().getSimpleName());}
        XC_MethodHook capture = new XC_MethodHook() {
            @Override protected void afterHookedMethod(MethodHookParam p) {
                if (!p.hasThrowable()) captureDatabase(p.thisObject);
            }
        };
        for (String name : new String[]{"rawQuery", "rawQueryWithFactory", "query", "queryWithFactory", "execSQL"}) {
            XposedBridge.hookAllMethods(database, name, capture);
        }
        XposedHelpers.findAndHookMethod(database, "insertWithOnConflict", String.class, String.class, ContentValues.class, int.class,
            new XC_MethodHook() {
                @Override protected void afterHookedMethod(MethodHookParam p) {
                    if (p.hasThrowable()) return;
                    captureDatabase(p.thisObject);
                    if ("message".equals(p.args[0]) && p.args[2] instanceof ContentValues) {
                        Number row = p.getResult() instanceof Number ? (Number)p.getResult() : -1;
                        if (row.longValue() > 0) record((ContentValues)p.args[2], row.longValue());
                    }
                }
            });

    }

    private void captureDatabase(Object database) {
        if (database == null || Boolean.TRUE.equals(ownQuery.get())) return;
        try {
            String path = (String)XposedHelpers.callMethod(database, "getPath");
            if (path != null && path.endsWith("/EnMicroMsg.db") && databases.size() < 4) databases.put(path, database);
        } catch (Throwable ignored) { }
    }

    private Cursor query(Object database, String sql, Object... args) throws Throwable {
        ownQuery.set(true);
        try { return (Cursor)XposedHelpers.callMethod(database, "rawQuery", sql, args); }
        finally { ownQuery.remove(); }
    }

    /** Resolve only a WeChat account/alias, never a nickname or group remark. */
    private JSONObject resolveIdentity(JSONObject request) throws Exception {
        String account=request.getString("wechat_id");
        if(!account.matches("[A-Za-z0-9_.-]{1,128}"))throw new IllegalArgumentException("invalid_account");
        Set<String> matches=new HashSet<>();Map<String,String> aliases=new HashMap<>();boolean queried=false;
        for(Object database:databases.values()){
            try(Cursor cursor=query(database,"SELECT username,alias FROM rcontact WHERE username=? COLLATE NOCASE OR alias=? COLLATE NOCASE LIMIT 3",account,account)){
                queried=true;
                while(cursor.moveToNext()){
                    String username=cursor.getString(0),alias=cursor.getString(1);
                    if(username!=null&&username.matches("[A-Za-z0-9_.-]{1,128}")&&(account.equalsIgnoreCase(username)||account.equalsIgnoreCase(alias))){matches.add(username);aliases.put(username,alias);}
                }
            }catch(Throwable ignored){}
        }
        boolean verified=queried&&matches.size()==1;
        return new JSONObject().put("wechat_id",account).put("verified",verified)
            .put("username",verified?matches.iterator().next():JSONObject.NULL)
            .put("alias",verified&&aliases.get(matches.iterator().next())!=null?aliases.get(matches.iterator().next()):JSONObject.NULL)
            .put("reason",verified?"account_exact_match":!queried?"contacts_unavailable":matches.isEmpty()?"account_not_found":"account_ambiguous");
    }

    private synchronized JSONArray refreshGroups() throws Exception {
        Map<String,List<String>> matches = new LinkedHashMap<>();
        Map<String,String> discovered = new LinkedHashMap<>();
        String placeholders = String.join(",", Collections.nCopies(names.size(), "?"));
        List<Object> args = new ArrayList<>(names.keySet()); args.addAll(names.keySet());
        String sql = "SELECT username,nickname,conRemark FROM rcontact WHERE username LIKE '%@chatroom' AND (nickname IN ("
            + placeholders + ") OR conRemark IN (" + placeholders + ")) LIMIT 20";
        for (Object database : databases.values()) {
            try (Cursor cursor = query(database, sql, args.toArray())) {
                while (cursor.moveToNext()) {
                    String id=cursor.getString(0), nickname=cursor.getString(1), remark=cursor.getString(2);
                    String name=names.get(nickname); if(name==null) name=names.get(remark);
                    if (name == null || id == null || !id.endsWith("@chatroom")) continue;
                    List<String> ids=matches.get(name); if(ids==null){ids=new ArrayList<>();matches.put(name,ids);}
                    if(!ids.contains(id)) ids.add(id);
                }
            } catch (Throwable ignored) { }
        }
        JSONArray output = new JSONArray();
        for (Map.Entry<String,List<String>> item : matches.entrySet()) {
            // Ambiguous names never silently authorize several groups.
            if (item.getValue().size() != 1) continue;
            String id=item.getValue().get(0); discovered.put(id,item.getKey());
        }
        synchronized(registrations){for(JSONObject item:registrations.values())discovered.put(item.getString("chat_id"),item.getString("chat_name"));}
        for(Map.Entry<String,String> item:discovered.entrySet())output.put(new JSONObject().put("id",item.getKey()).put("name",item.getValue()).put("type","group").put("verified",true));
        groups=Collections.unmodifiableMap(discovered);
        return output;
    }

    private String groupName(String group){
        String existing=groups.get(group);if(existing!=null)return existing;
        for(Object database:databases.values()){
            try(Cursor cursor=query(database,"SELECT nickname,conRemark FROM rcontact WHERE username=? LIMIT 1",group)){
                if(cursor.moveToFirst())for(int i=0;i<2;i++){
                    String name=cursor.getString(i);if(name!=null&&!name.trim().isEmpty())return name.substring(0,Math.min(128,name.length()));
                }
            }catch(Throwable ignored){}
        }
        return group;
    }

    private void saveRegistrations() throws Exception {
        JSONArray saved=new JSONArray();for(JSONObject item:registrations.values())saved.put(item);
        if(!registrationStore.edit().putString("requests",saved.toString()).commit())throw new IOException("registration_save_failed");
    }

    private void requestSignup(String group,String requestId,long time) throws Exception {
        synchronized(registrations){
            JSONObject previous=registrations.get(group);
            if(previous!=null&&(previous.getString("request_id").equals(requestId)||previous.optString("ack_state").equals("pending")||time-previous.getLong("requested_at")<60000))return;
            if(previous==null&&registrations.size()>=198)return;
            JSONObject item=new JSONObject().put("request_id",requestId).put("chat_id",group)
                .put("chat_name",groupName(group)).put("requested_at",time).put("ack_state","pending");
            registrations.put(group,item);
            try{saveRegistrations();}catch(Exception error){if(previous==null)registrations.remove(group);else registrations.put(group,previous);throw error;}
        }
    }

    private JSONArray signupRequests() throws Exception {
        JSONArray output=new JSONArray();
        synchronized(registrations){for(JSONObject item:registrations.values())if(item.optString("ack_state").equals("pending")){
            output.put(new JSONObject().put("request_id",item.getString("request_id")).put("chat_id",item.getString("chat_id"))
                .put("chat_name",item.getString("chat_name")).put("requested_at",item.getLong("requested_at")));
        }}
        return output;
    }

    private JSONObject acknowledgeSignup(JSONObject request) throws Exception {
        String group=request.getString("chat_id"),requestId=request.getString("request_id");JSONObject item;
        synchronized(registrations){
            item=registrations.get(group);
            if(item==null||!item.getString("request_id").equals(requestId))return new JSONObject().put("state","failed").put("reason","signup_request_not_found");
            if(!item.getString("ack_state").equals("pending"))return item.getJSONObject("ack_result");
            // Persist the reservation before publishing. Restarts and HTTP retries cannot send twice.
            item.put("ack_state","uncertain").put("ack_result",new JSONObject().put("state","uncertain").put("reason","signup_ack_reserved"));
            saveRegistrations();
        }
        String id="signup:"+UUID.nameUUIDFromBytes(requestId.getBytes(StandardCharsets.UTF_8));
        JSONObject result=send(new JSONObject().put("chat_id",group).put("content","已发起使用请求").put("id",id),true);
        synchronized(registrations){item.put("ack_state",result.getString("state")).put("ack_result",result);saveRegistrations();}
        return result;
    }

    private JSONObject authorize(JSONObject request) throws Exception {
        refreshGroups();JSONArray ids=request.getJSONArray("chat_ids");if(ids.length()>200)throw new IllegalArgumentException("authorization_limit");
        Set<String> updated=new HashSet<>();for(int i=0;i<ids.length();i++){
            String id=ids.getString(i);if(!groups.containsKey(id))throw new SecurityException("unknown_group");updated.add(id);
        }
        authorized=Collections.unmodifiableSet(updated);return new JSONObject().put("ok",true);
    }

    private JSONObject botQuote(String group,GroupReplyCard card) throws Exception {
        if(card==null)return null;
        for(Object database:databases.values())try(Cursor row=query(database,"SELECT type,content FROM message WHERE talker=? AND msgSvrId=? AND isSend=1 LIMIT 1",group,Long.parseLong(card.serverId))){
            if(!row.moveToFirst())continue;
            int type=row.getInt(0);String content=type==1?row.getString(1):type==3?"[Gemini 发出的图片]":"[Gemini 发出的非文字消息]";
            if(content==null)content="";
            return new JSONObject().put("message_id",group+":s"+card.serverId).put("own",true)
                .put("type",type==1?"text":type==3?"image":"other").put("content",content.substring(0,Math.min(8000,content.length())));
        }catch(Throwable ignored){}
        return null;
    }
    private JSONObject groupEvent(ContentValues value,long row,boolean historical) throws Exception {
        String group=value.getAsString("talker");Integer type=value.getAsInteger("type");
        if(group==null||!group.matches("[A-Za-z0-9_\\-]+@chatroom")||type==null||(type!=1&&(type&65535)!=49))return null;
        if(!Integer.valueOf(0).equals(value.getAsInteger("isSend")))return null;
        Long time=value.getAsLong("createTime");
        if(time==null||(!historical&&time<started)||time>System.currentTimeMillis()+60000)return null;
        String raw=value.getAsString("content");if(raw==null||raw.length()>((type&65535)==49?100128:8128))return null;
        int split=raw.indexOf(":\n");if(split<=0||split>128)return null;
        String sender=raw.substring(0,split),content=raw.substring(split+2);
        if(!sender.matches("[A-Za-z0-9_@.\\-]{1,128}"))return null;
        Long server=value.getAsLong("msgSvrId");String messageId=group+":"+(server!=null&&server>0?"s"+server:"l"+row);
        if(type==1&&!historical&&BotMentions.signup(content)){
            requestSignup(group,messageId,time);return null;
        }
        String name=groups.get(group);if(name==null||!authorized.contains(group))return null;
        JSONObject quoted=null;
        if((type&65535)==49){
            GroupReplyCard card=GroupReplyCard.parse(content);if(card==null)return null;
            quoted=botQuote(group,card);if(quoted==null)return null;
            content=card.text;
        }
        boolean mentioned=BotMentions.contains(content);
        if(quoted==null&&!content.trim().startsWith("/")&&!mentioned)return null;
        JSONObject event=new JSONObject().put("event","message.received").put("message_id",messageId)
            .put("chat_id",group).put("chat_name",name).put("chat_type","group").put("sender",sender).put("sender_wxid",sender)
            .put("content",content).put("own",false).put("mention",quoted!=null?"reply":mentioned?"text":"none").put("timestamp",time);
        if(quoted!=null)event.put("reply_to",quoted);
        return event;
    }
    private void record(ContentValues value,long row){
        try{
            JSONObject event=groupEvent(value,row,false);if(event==null)return;
            synchronized(events){event.put("seq",++sequence);events.add(event);while(events.size()>100)events.remove(0);}
        }catch(Throwable error){Log.w("NilaWeChatHook","group_event_failed:"+error.getClass().getSimpleName());}
    }
    /** Read-only inspection/recovery uses the same parser and same-group bot proof. */
    private JSONArray recentReplies(String group,long since,String messageId) throws Exception {
        if(!groups.containsKey(group)||!authorized.contains(group))throw new SecurityException("group_not_authorized");
        if(since<0||since<System.currentTimeMillis()-86400000L||since>System.currentTimeMillis())throw new IllegalArgumentException("reply_time_range");
        JSONArray output=new JSONArray();
        for(Object database:databases.values())try(Cursor rows=query(database,"SELECT msgId,talker,type,isSend,createTime,content,msgSvrId FROM message WHERE talker=? AND isSend=0 AND (type & 65535)=49 AND createTime>=? ORDER BY msgId DESC LIMIT 100",group,since)){
            while(rows.moveToNext()){
                long local=rows.getLong(0),server=rows.getLong(6);String id=group+":"+(server>0?"s"+server:"l"+local);
                if(messageId!=null&&!messageId.equals(id))continue;
                ContentValues v=new ContentValues();v.put("talker",rows.getString(1));v.put("type",rows.getInt(2));v.put("isSend",rows.getInt(3));v.put("createTime",rows.getLong(4));v.put("content",rows.getString(5));v.put("msgSvrId",server);
                JSONObject event=groupEvent(v,local,true);if(event!=null){output.put(event);if(output.length()>=20)return output;}
            }
        }catch(Throwable error){Log.w("NilaWeChatHook","reply_lookup_failed:"+error.getClass().getSimpleName());}
        return output;
    }

    /** Fixed read-only query, bounded and restricted to an explicitly authorized group.
     * The host commits this local-row cursor alongside the archive. It is independent
     * of the transient trigger ring, so downtime never turns old chat into replies. */
    private JSONObject history(URI uri) throws Exception {
        Map<String,String> params=new HashMap<>();
        if(uri.getRawQuery()!=null)for(String pair:uri.getRawQuery().split("&")){
            String[] parts=pair.split("=",2);
            params.put(URLDecoder.decode(parts[0],"UTF-8"),parts.length==2?URLDecoder.decode(parts[1],"UTF-8"):"");
        }
        String group=params.get("chat_id"),requestedSource=params.get("source");
        if(group==null||!group.matches("[A-Za-z0-9_\\-]+@chatroom")||!authorized.contains(group)||!groups.containsKey(group))throw new SecurityException("group_not_authorized");
        long since=Long.parseLong(params.get("since")),after=Long.parseLong(params.get("after"));
        if(since<0||since>System.currentTimeMillis()+60000||after<0)throw new IllegalArgumentException("invalid_history_cursor");
        for(Map.Entry<String,Object> entry:databases.entrySet()){
            try {
                Object database=entry.getValue();
                try(Cursor known=query(database,"SELECT username FROM rcontact WHERE username=? LIMIT 1",group)){if(!known.moveToFirst())continue;}
                StringBuilder hex=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(entry.getKey().getBytes(StandardCharsets.UTF_8)))hex.append(String.format(Locale.ROOT,"%02x",b&255));
                String source=hex.toString();long cursor=source.equals(requestedSource)?after:0;
                JSONArray rows=new JSONArray();int scanned=0;Map<String,String> displayNames=new HashMap<>();
                try(Cursor records=query(database,"SELECT msgId,createTime,content FROM message WHERE talker=? AND type=1 AND isSend=0 AND msgId>? AND createTime>=? AND createTime<=? ORDER BY msgId ASC LIMIT 100",group,cursor,since,System.currentTimeMillis())){
                    while(records.moveToNext()){
                        scanned++;cursor=records.getLong(0);long timestamp=records.getLong(1);String raw=records.getString(2);
                        if(raw==null)continue;int split=raw.indexOf(":\n");if(split<=0||split>128)continue;
                        String sender=raw.substring(0,split),content=raw.substring(split+2);
                        if(!sender.matches("[A-Za-z0-9_@.\\-]+"))continue;
                        String name=displayNames.get(sender);
                        if(name==null){
                            name=sender;
                            try(Cursor contact=query(database,"SELECT nickname FROM rcontact WHERE username=? LIMIT 1",sender)){
                                if(contact.moveToFirst()&&contact.getString(0)!=null&&!contact.getString(0).isEmpty())name=contact.getString(0);
                            }catch(Throwable ignored) { }
                            displayNames.put(sender,name);
                        }
                        rows.put(new JSONObject().put("local_id",cursor).put("sender_id",sender).put("sender",name.substring(0,Math.min(128,name.length())))
                            .put("content",content.substring(0,Math.min(8000,content.length()))).put("timestamp",timestamp).put("truncated",content.length()>8000));
                    }
                }
                return new JSONObject().put("chat_id",group).put("source",source).put("cursor",cursor).put("has_more",scanned==100).put("messages",rows);
            }catch(Throwable error){Log.w("NilaWeChatHook","group_history_failed:"+error.getClass().getSimpleName());}
        }
        throw new IllegalStateException("history_database_unavailable");
    }

    private JSONObject send(JSONObject request,boolean signupAck) throws Exception {
        String group=request.getString("chat_id"), content=request.getString("content"), id=request.getString("id");
        if(!id.matches("[A-Za-z0-9_:.\\-]{8,150}") || content.trim().isEmpty() || content.length()>2000) throw new IllegalArgumentException("invalid_send");
        refreshGroups(); if(!groups.containsKey(group)) throw new SecurityException("group_not_allowed");
        if(!signupAck&&!authorized.contains(group))throw new SecurityException("group_not_authorized");
        if(signupAck&&!content.equals("已发起使用请求"))throw new SecurityException("invalid_signup_ack");
        return sendReserved(group,content,id);
    }

    private JSONObject sendReserved(String group,String content,String id) throws Exception {
        // Persist before publishing, including across WeChat restarts.
        TextSendLedger.Receipt receipt;
        try{receipt=textSends.reserve(id,group,content);}
        catch(IOException error){
            Log.w("NilaWeChatHook","text_reservation_failed:"+error.getMessage());
            return new JSONObject().put("state","failed").put("reason","text_reservation_failed");
        }
        if(!receipt.created)return new JSONObject().put("state",receipt.state).put("reason",receipt.reason);
        JSONObject result=new JSONObject().put("state","uncertain").put("reason","no_server_ack_yet");
        try{result=publishText(group,content);}
        catch(Throwable error){result.put("reason","send_exception_"+error.getClass().getSimpleName());}
        finally{
            try{textSends.finish(id,group,content,result.getString("state"),result.getString("reason"));}
            catch(IOException error){
                Log.w("NilaWeChatHook","text_receipt_update_failed:"+error.getClass().getSimpleName());
                result.put("state","uncertain").put("reason","text_receipt_update_failed");
            }
        }
        return result;
    }

    private boolean knownFriend(Object database,String user) throws Throwable {
        if(user==null||!user.matches("[A-Za-z0-9_.-]{1,128}")||user.startsWith("gh_")||user.equals("filehelper"))return false;
        try(Cursor contact=query(database,"SELECT type FROM rcontact WHERE username=? LIMIT 1",user)){
            return contact.moveToFirst()&&(contact.getInt(0)&1)!=0;
        }
    }
    private JSONObject authorizePrivate(JSONObject request) throws Exception {
        JSONArray ids=request.getJSONArray("user_ids");
        if(ids.length()>20)throw new IllegalArgumentException("private_authorization_limit");
        Set<String> updated=new HashSet<>();
        for(int i=0;i<ids.length();i++){
            String user=ids.getString(i);boolean known=false;
            for(Object database:databases.values())try{if(knownFriend(database,user))known=true;}catch(Throwable ignored){}
            if(!known)throw new SecurityException("private_contact_not_verified");
            updated.add(user);
        }
        privateAuthorized=Collections.unmodifiableSet(updated);
        return new JSONObject().put("ok",true).put("generation",generation);
    }
    /** Match only the fresh, exact one-time pairing phrase supplied on the host.
     * No other private text is returned or scanned into the bot's history. */
    private JSONObject pairPrivate(JSONObject request) throws Exception {
        String content=request.getString("content");long since=request.getLong("since"),now=System.currentTimeMillis();
        if(!content.matches("绑定发帖 [a-f0-9]{8}")||since<now-1800000L||since>now+60000)throw new IllegalArgumentException("invalid_pairing");
        Set<String> matches=new HashSet<>();int queried=0,found=0,friends=0;JSONArray times=new JSONArray();
        for(Object database:databases.values()){
            try(Cursor records=query(database,"SELECT talker,createTime FROM message WHERE isSend=0 AND type=1 AND content=? ORDER BY msgId DESC LIMIT 3",content)){
                queried++;
                while(records.moveToNext()){
                    found++;String user=records.getString(0);long time=records.getLong(1);
                    times.put(time);
                    if(knownFriend(database,user)){
                        friends++;
                        if(time>=since&&time<=now+60000L)matches.add(user);
                    }
                }
            }catch(Throwable error){Log.w("NilaWeChatHook","private_pairing_failed:"+error.getClass().getSimpleName());}
        }
        return new JSONObject().put("verified",matches.size()==1)
            .put("username",matches.size()==1?matches.iterator().next():JSONObject.NULL)
            .put("queried",queried).put("matched_messages",found).put("friend_matches",friends).put("timestamps",times);
    }
    private JSONObject sendPrivate(JSONObject request) throws Exception {
        String user=request.getString("user_id"),content=request.getString("content"),id=request.getString("id");
        if(!privateAuthorized.contains(user))throw new SecurityException("private_not_authorized");
        if(!id.matches("[A-Za-z0-9_:.\\-]{8,150}")||content.trim().isEmpty()||content.length()>2000)throw new IllegalArgumentException("invalid_private_send");
        boolean known=false;
        for(Object database:databases.values())try{if(knownFriend(database,user))known=true;}catch(Throwable ignored){}
        if(!known)throw new SecurityException("private_contact_not_verified");
        return sendReserved(user,content,id);
    }
    /** Text and ordinary shared-link cards only; never return unrelated private chats. */
    private JSONObject privateHistory(JSONObject request) throws Exception {
        String user=request.getString("user_id"),requestedSource=request.optString("source","");
        long since=request.getLong("since"),after=request.getLong("after"),now=System.currentTimeMillis();
        if(!privateAuthorized.contains(user))throw new SecurityException("private_not_authorized");
        if(since<0||since>now+60000||after<0)throw new IllegalArgumentException("invalid_private_cursor");
        since=Math.max(since,now-86400000L);
        for(Map.Entry<String,Object> entry:databases.entrySet()){
            try{
                Object database=entry.getValue();if(!knownFriend(database,user))continue;
                StringBuilder hex=new StringBuilder();
                for(byte b:MessageDigest.getInstance("SHA-256").digest(entry.getKey().getBytes(StandardCharsets.UTF_8)))hex.append(String.format(Locale.ROOT,"%02x",b&255));
                String source=hex.toString();long cursor=source.equals(requestedSource)?after:0;
                JSONArray rows=new JSONArray();int scanned=0;
                try(Cursor records=query(database,"SELECT msgId,createTime,content,type,msgSvrId FROM message WHERE talker=? AND isSend=0 AND type IN (1,49) AND msgId>? AND createTime>=? AND createTime<=? ORDER BY msgId ASC LIMIT 50",user,cursor,since,now)){
                    while(records.moveToNext()){
                        scanned++;cursor=records.getLong(0);String content=records.getString(2);
                        if(content==null||content.length()>100000)continue;
                        if(records.getInt(3)==49)content=PrivateLinkCard.extract(content);
                        if(content==null||content.length()>8000)continue;
                        long server=records.getLong(4);
                        rows.put(new JSONObject().put("message_id",user+":"+(server>0?"s"+server:"l"+cursor))
                            .put("user_id",user).put("content",content).put("timestamp",records.getLong(1)));
                    }
                }
                return new JSONObject().put("source",source).put("cursor",cursor).put("has_more",scanned==50).put("messages",rows);
            }catch(Throwable error){Log.w("NilaWeChatHook","private_history_failed:"+error.getClass().getSimpleName());}
        }
        throw new IllegalStateException("private_database_unavailable");
    }

    private JSONObject publishText(String group,String content) throws Exception {
        JSONObject result=new JSONObject().put("state","uncertain").put("reason","no_server_ack_yet");
        // WeChat derives createTime from its own clock. Fence by local row ID,
        // not wall time, so a successful send cannot disappear behind skew.
        long before=0;boolean fenced=false;
        for(Object database:databases.values()) {
            try(Cursor cursor=query(database,"SELECT max(msgId) FROM message")) {
                if(cursor.moveToFirst()){before=Math.max(before,cursor.getLong(0));fenced=true;}
            }catch(Throwable ignored){ }
        }
        if(!fenced){result.put("state","failed").put("reason","message_fence_unavailable");return result;}
        pendingGroup=group;networkResult=null;
        FutureTask<Boolean> task=new FutureTask<>(() -> {
            Class<?> type=Class.forName("com.tencent.mm.autogen.events.SendMsgEvent",true,loader);
            Object event=type.getDeclaredConstructor().newInstance(); Object payload=type.getField("g").get(event);
            payload.getClass().getField("a").set(payload,group);
            payload.getClass().getField("b").set(payload,content);
            payload.getClass().getField("c").setInt(payload,1);
            payload.getClass().getField("d").setInt(payload,0);
            payload.getClass().getField("e").set(payload,"");
            return (Boolean)type.getMethod("e").invoke(event);
        });
        main.post(task);
        try {
            boolean accepted=task.get(5,TimeUnit.SECONDS);
            result.put("event_accepted",accepted);
            if(!accepted) { result.put("reason","event_had_no_listener");return result; }
            long deadline=System.currentTimeMillis()+12000;
            while(System.currentTimeMillis()<deadline) {
                for(Object database:databases.values()) {
                    try(Cursor cursor=query(database,"SELECT msgId,status,msgSvrId FROM message WHERE talker=? AND isSend=1 AND type=1 AND content=? AND msgId>? ORDER BY msgId DESC LIMIT 1",group,content,before)) {
                        if(cursor.moveToFirst()) {
                            result.put("local_id",cursor.getLong(0)).put("wechat_status",cursor.getInt(1)).put("has_server_id",cursor.getLong(2)>0);
                            if(networkResult!=null)result.put("network",networkResult);
                            if(cursor.getInt(1)==2 && cursor.getLong(2)>0) {
                                result.put("state","sent").put("reason","wechat_server_ack");return result;
                            }
                            if(cursor.getInt(1)==5){result.put("state","failed").put("reason","wechat_send_failed");return result;}
                        }
                    } catch(Throwable error) {result.put("lookup_error",error.getClass().getSimpleName());}
                }
                Thread.sleep(200);
            }
        } catch(Throwable error) {task.cancel(false);result.put("reason","send_exception_"+error.getClass().getSimpleName());}
        finally {pendingGroup=null;}
        return result;
    }

    private JSONObject delivery(JSONObject request) throws Exception {
        String group=request.getString("chat_id"),content=request.getString("content");
        if(content.isEmpty()||content.length()>2000)throw new IllegalArgumentException("content");
        refreshGroups();if(!groups.containsKey(group))throw new SecurityException("group_not_allowed");
        // Read-only diagnosis for an exact known test message; no general SQL API.
        JSONObject result=new JSONObject().put("found",false);
        for(Object database:databases.values()) {
            try(Cursor cursor=query(database,"SELECT msgId,status,msgSvrId,createTime FROM message WHERE talker=? AND isSend=1 AND type=1 AND content=? ORDER BY msgId DESC LIMIT 1",group,content)) {
                if(cursor.moveToFirst())return result.put("found",true).put("local_id",cursor.getLong(0))
                    .put("wechat_status",cursor.getInt(1)).put("server_ack",cursor.getInt(1)==2&&cursor.getLong(2)>0).put("timestamp",cursor.getLong(3));
            }catch(Throwable error){result.put("lookup_error",error.getClass().getSimpleName());}
        }
        return result;
    }

    private static final class ImageDownload {
        final long started=System.currentTimeMillis();
        volatile String state="pending";
        Object service,listener,messageKey;
        long imageId;int type;
    }
    private final Map<String,ImageDownload> imageDownloads=new ConcurrentHashMap<>();

    private List<GroupImageMembers.Member> imageMembers(Object database,String group) throws Throwable {
        Object room;
        try(Cursor row=query(database,"SELECT * FROM chatroom WHERE chatroomname=? LIMIT 1",group)){
            if(!row.moveToFirst())throw new IllegalStateException("room_roster_missing");
            room=Class.forName("com.tencent.mm.storage.z2",true,loader).getDeclaredConstructor().newInstance();
            XposedHelpers.callMethod(room,"convertFrom",row);
        }
        List<?> ids=(List<?>)XposedHelpers.callMethod(room,"z0");
        if(ids.size()>5000)throw new IllegalStateException("room_roster_limit");
        List<GroupImageMembers.Member> members=new ArrayList<>();
        for(Object item:ids){
            String id=String.valueOf(item);
            if(!id.matches("[A-Za-z0-9_@.\\-]{1,128}"))continue;
            String roomName=(String)XposedHelpers.callMethod(room,"u0",id),nickname="",remark="",alias="";
            try(Cursor row=query(database,"SELECT nickname,conRemark,alias FROM rcontact WHERE username=? LIMIT 1",id)){
                if(row.moveToFirst()){nickname=row.getString(0);remark=row.getString(1);alias=row.getString(2);}
            }
            members.add(new GroupImageMembers.Member(id,roomName,nickname,remark,alias));
        }
        return members;
    }
    private Set<String> imageMentions(String source){
        Set<String> ids=new HashSet<>();
        if(source==null)return ids;
        java.util.regex.Matcher match=java.util.regex.Pattern.compile("<atuserlist>(?:<!\\[CDATA\\[)?([^<]*?)(?:\\]\\]>)?</atuserlist>").matcher(source);
        if(match.find())for(String id:match.group(1).split(","))if(id.matches("[A-Za-z0-9_@.\\-]{1,128}"))ids.add(id);
        return ids;
    }

    /** The anchor author is verified independently from the selected image author. */
    private JSONObject latestImage(JSONObject request) throws Exception {
        String group=request.getString("chat_id"),sender=request.getString("sender_id"),anchor=request.getString("request_message_id");
        String selector=request.optString("member","");
        if(!groups.containsKey(group)||!authorized.contains(group))return imageError("group_not_authorized");
        if(selector.length()>128||!sender.matches("[A-Za-z0-9_@.\\-]{1,128}")||!anchor.startsWith(group+":"))return imageError("invalid_image_scope");
        String key=anchor.substring(group.length()+1);
        if(!key.matches("[sl][1-9][0-9]{0,18}"))return imageError("invalid_image_scope");
        long number=Long.parseLong(key.substring(1));String imageStage="anchor";
        for(Object database:databases.values())try {
            long before,anchorId;String source;
            try(Cursor row=query(database,"SELECT * FROM message WHERE talker=? AND isSend=0 AND (type=1 OR (type & 65535)=49) AND "+(key.charAt(0)=='s'?"msgSvrId":"msgId")+"=? LIMIT 1",group,number)){
                if(!row.moveToFirst())continue;
                String text=row.getString(row.getColumnIndexOrThrow("content"));
                if(text==null||!text.startsWith(sender+":\n"))return imageError("image_sender_mismatch");
                anchorId=row.getLong(row.getColumnIndexOrThrow("msgId"));before=row.getLong(row.getColumnIndexOrThrow("createTime"));
                Object trigger=Class.forName("com.tencent.mm.storage.e9",true,loader).getDeclaredConstructor().newInstance();
                XposedHelpers.callMethod(trigger,"convertFrom",row);source=(String)XposedHelpers.getObjectField(trigger,"G");
            }
            imageStage="members";List<GroupImageMembers.Member> roster=imageMembers(database,group);
            List<GroupImageMembers.Member> matches=GroupImageMembers.resolve(roster,selector,sender,imageMentions(source));
            if(matches.isEmpty())return imageError("image_member_not_found");
            if(matches.size()!=1){
                JSONArray candidates=new JSONArray();
                for(GroupImageMembers.Member m:matches)if(candidates.length()<8)candidates.put(new JSONObject().put("id",m.id).put("name",m.name));
                return imageError("image_member_ambiguous").put("candidates",candidates);
            }
            GroupImageMembers.Member target=matches.get(0);
            imageStage="selection";String prefix=target.id+":\n";Object message;long local,server,time;String thumb;
            try(Cursor row=query(database,GroupImageQuery.LATEST,group,before,before,anchorId,prefix.length(),prefix)){
                if(!row.moveToFirst())return imageError("image_not_found");
                local=row.getLong(row.getColumnIndexOrThrow("msgId"));server=row.getLong(row.getColumnIndexOrThrow("msgSvrId"));
                time=row.getLong(row.getColumnIndexOrThrow("createTime"));thumb=row.getString(row.getColumnIndexOrThrow("imgPath"));
                message=Class.forName("com.tencent.mm.storage.e9",true,loader).getDeclaredConstructor().newInstance();
                XposedHelpers.callMethod(message,"convertFrom",row);
            }
            Object storage=XposedHelpers.callStaticMethod(Class.forName("v51.b1",true,loader),"Bj");
            imageStage="clear_image";Object info=XposedHelpers.callMethod(storage,"F3",group,local,server);
            JSONObject encoded=readClearImage(storage,message,info);
            String download="not_needed",quality="image";
            if(encoded==null&&info!=null){
                download=requestImageDownload(storage,info,group,local);
                if(download.equals("pending"))return new JSONObject().put("ok",false).put("error","image_downloading").put("retry_after_ms",1000);
                // Refresh metadata after the native callback, never reuse an incomplete row.
                info=XposedHelpers.callMethod(storage,"F3",group,local,server);
                encoded=readClearImage(storage,message,info);
            }
            if(encoded==null){
                Class<?> kinds=Class.forName("pv5.e0",true,loader);
                String path=(String)XposedHelpers.callMethod(storage,"k4",message,XposedHelpers.getStaticObjectField(kinds,"i"),thumb);
                try{if(path!=null)encoded=encodeLocalImage(path);}catch(Throwable ignored){}
                quality="thumbnail";
            }
            if(encoded==null)return imageError("image_not_downloaded");
            if(!authorized.contains(group))return imageError("group_not_authorized");
            return encoded.put("ok",true).put("chat_id",group).put("sender_id",sender).put("member",selector)
                .put("target_id",target.id).put("target_name",target.name).put("request_message_id",anchor)
                .put("message_id",group+":"+(server>0?"s"+server:"l"+local)).put("timestamp",time).put("quality",quality).put("download",download);
        }catch(Throwable error){Throwable cause=error;while(cause.getCause()!=null&&cause.getCause()!=cause)cause=cause.getCause();Log.w("NilaWeChatHook","image_read_failed:"+imageStage+":"+cause.getClass().getSimpleName());return imageError("image_read_failed");}
        return imageError("image_request_not_found");
    }
    private static JSONObject imageError(String code) throws Exception {return new JSONObject().put("ok",false).put("error",code);}

    private JSONObject readClearImage(Object storage,Object message,Object info) throws Throwable {
        if(info==null)return null;
        List<Object> versions=new ArrayList<>();
        long original=XposedHelpers.getLongField(info,"q");
        if(original>0)versions.add(XposedHelpers.callMethod(storage,"C3",Long.valueOf(original)));
        versions.add(info);Class<?> kinds=Class.forName("pv5.e0",true,loader);
        for(Object version:versions){
            if(!Boolean.TRUE.equals(XposedHelpers.callMethod(version,"l")))continue;
            // bigImgPath holds the received standard image too; compressType picks its directory.
            int compression=XposedHelpers.getIntField(version,"h");
            for(String[] field:new String[][]{{"e",compression==1?"g":"h"},{"f","h"}}){
                String name=(String)XposedHelpers.getObjectField(version,field[0]);
                if(name==null||name.isEmpty())continue;
                try{
                    String path=(String)XposedHelpers.callMethod(storage,"n4",message,XposedHelpers.getStaticObjectField(kinds,field[1]),name,"","");
                    JSONObject image=path==null?null:encodeLocalImage(path);
                    if(image!=null)return image;
                }catch(Throwable ignored){}
            }
        }
        return null;
    }
    /** Schedule WeChat's own authenticated download without blocking the local API. */
    private String requestImageDownload(Object storage,Object info,String group,long local) throws Throwable {
        long imageId=XposedHelpers.getLongField(info,"a");if(imageId<=0)return "metadata_missing";
        int type=0;long original=XposedHelpers.getLongField(info,"q");
        if(original>0){
            Object hd=XposedHelpers.callMethod(storage,"C3",Long.valueOf(original));
            int size=XposedHelpers.getIntField(hd,"d");
            if(size>0&&size<=20*1024*1024)type=1;
        }
        if(type==0&&XposedHelpers.getIntField(info,"d")>20*1024*1024)return "source_too_large";
        String key=group+":"+local+":"+type;long now=System.currentTimeMillis();
        for(Map.Entry<String,ImageDownload> item:imageDownloads.entrySet())if(now-item.getValue().started>120000&&!item.getValue().state.equals("pending"))imageDownloads.remove(item.getKey(),item.getValue());
        ImageDownload previous=imageDownloads.get(key);if(previous!=null)return previous.state;
        if(imageDownloads.size()>=32)return "download_busy";
        ImageDownload task=new ImageDownload();task.imageId=imageId;task.type=type;imageDownloads.put(key,task);
        main.post(()->{
            try{
                if(!authorized.contains(group)){task.state="revoked";return;}
                Class<?> ownerType=Class.forName("v51.b1",true,loader);Object owner=XposedHelpers.callStaticMethod(ownerType,"zj");
                Object service=XposedHelpers.getObjectField(owner,"f");
                if(service==null){service=Class.forName("v51.j",true,loader).getDeclaredConstructor().newInstance();XposedHelpers.setObjectField(owner,"f",service);}
                task.service=service;
                task.messageKey=Class.forName("com.tencent.mm.plugin.msg.MsgIdTalker",true,loader).getConstructor(long.class,String.class).newInstance(local,group);
                Class<?> listenerType=Class.forName("ea0.w",true,loader);
                task.listener=java.lang.reflect.Proxy.newProxyInstance(loader,new Class[]{listenerType},(proxy,method,args)->{
                    if(method.getName().equals("hashCode"))return System.identityHashCode(proxy);
                    if(method.getName().equals("equals"))return proxy==args[0];
                    if(method.getName().equals("toString"))return "NilaImageReader";
                    if(method.getName().equals("c"))task.state=((Number)args[6]).intValue()==0&&((Number)args[7]).intValue()==0?"downloaded":"download_failed";
                    if(method.getName().equals("o"))task.state="download_cancelled";
                    return null;
                });
                boolean accepted=Boolean.TRUE.equals(XposedHelpers.callMethod(service,"c",imageId,task.messageKey,task.type,null,0,task.listener));
                if(!accepted)task.state="download_rejected";
            }catch(Throwable error){task.state="download_unavailable";Log.w("NilaWeChatHook","image_download_failed:"+error.getClass().getSimpleName());}
        });
        main.postDelayed(()->{
            if(task.state.equals("pending")){
                task.state="download_timeout";
                // Remove only our listener; never cancel another caller's download.
                try{if(task.service!=null&&task.listener!=null)XposedHelpers.callMethod(task.service,"g",task.imageId,task.messageKey,task.type,task.listener);}catch(Throwable ignored){}
            }
        },35000);
        return "pending";
    }
    private JSONObject encodeLocalImage(String path) throws Throwable {
        // Paths come exclusively from WeChat's image store for the selected row.
        Class<?> vfs=Class.forName("com.tencent.mm.vfs.z6",true,loader);
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(InputStream input=(InputStream)XposedHelpers.callStaticMethod(vfs,"E",path)){
            byte[] block=new byte[16384];int n;
            while((n=input.read(block))!=-1){if(bytes.size()+n>20*1024*1024)return null;bytes.write(block,0,n);}
        }
        byte[] data=bytes.toByteArray();BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(data,0,data.length,options);
        if(options.outWidth<=0||options.outHeight<=0||options.outWidth>30000||options.outHeight>30000)return null;
        int originalWidth=options.outWidth,originalHeight=options.outHeight;
        options.inJustDecodeBounds=false;options.inSampleSize=1;
        while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>4096)options.inSampleSize*=2;
        Bitmap bitmap=BitmapFactory.decodeByteArray(data,0,data.length,options);if(bitmap==null)return null;
        try{
            ByteArrayOutputStream output=new ByteArrayOutputStream();
            if(!bitmap.compress(Bitmap.CompressFormat.JPEG,90,output)||output.size()>6*1024*1024)return null;
            return new JSONObject().put("mime_type","image/jpeg").put("data",Base64.encodeToString(output.toByteArray(),Base64.NO_WRAP))
                .put("width",bitmap.getWidth()).put("height",bitmap.getHeight()).put("original_width",originalWidth).put("original_height",originalHeight);
        }finally{bitmap.recycle();}
    }

    private JSONObject sendVoice(JSONObject request) throws Exception {
        String group=request.getString("chat_id"),id=request.getString("id");
        if(!id.matches("[a-f0-9\\-]{36}")||!request.getString("mime_type").equals("audio/silk"))throw new IllegalArgumentException("invalid_voice_request");
        refreshGroups();if(!groups.containsKey(group)||!authorized.contains(group))throw new SecurityException("group_not_authorized");
        String encoded=request.getString("data");if(encoded.length()>1400000)throw new IllegalArgumentException("voice_size");
        byte[] data=Base64.decode(encoded,Base64.DEFAULT);int duration=SilkAudio.duration(data);
        if(request.getInt("duration_ms")!=duration)throw new IllegalArgumentException("voice_duration_mismatch");
        StringBuilder hash=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))hash.append(String.format(Locale.ROOT,"%02x",b&255));
        String binding="voice:"+hash+":"+duration;
        TextSendLedger.Receipt receipt=textSends.reserve(id,group,binding);
        if(!receipt.created)return new JSONObject().put("state",receipt.state).put("reason",receipt.reason);
        JSONObject result=new JSONObject().put("state","uncertain").put("reason","voice_send_reserved");
        try { result=publishVoice(group,"wbot_"+id.replace("-",""),data,duration); }
        catch(Throwable error){result.put("reason","voice_send_exception_"+error.getClass().getSimpleName());}
        finally{
            try{textSends.finish(id,group,binding,result.getString("state"),result.getString("reason"));}
            catch(IOException error){result.put("state","uncertain").put("reason","voice_receipt_update_failed");}
        }
        return result;
    }
    private JSONObject publishVoice(String group,String filename,byte[] data,int duration) throws Exception {
        final java.util.concurrent.atomic.AtomicBoolean invoked=new java.util.concurrent.atomic.AtomicBoolean();
        final Object[] nativeParams=new Object[1];
        JSONObject result=new JSONObject().put("state","uncertain").put("reason","no_server_ack_yet");
        FutureTask<Boolean> task=new FutureTask<>(()->{
            Class<?> registry=Class.forName("ni5.n0",true,loader);
            Object storage=registry.getMethod("c",Class.class).invoke(null,Class.forName("no3.u0",true,loader));
            Class<?> resourceType=Class.forName("pv5.x",true,loader);
            Object builder=XposedHelpers.getStaticObjectField(resourceType,"i");
            Object audioType=XposedHelpers.getStaticObjectField(Class.forName("pv5.e0",true,loader),"u");
            Object audioResource=builder.getClass().getMethod("d",Class.forName("oq3.g",true,loader),Class.forName("pv5.e0",true,loader)).invoke(builder,null,audioType);
            Object legacyResource=XposedHelpers.getStaticObjectField(resourceType,"j");
            Class<?> vfs=Class.forName("com.tencent.mm.vfs.z6",true,loader);
            Set<String> paths=new HashSet<>();
            for(Object resource:new Object[]{audioResource,legacyResource}){
                String path=(String)XposedHelpers.callMethod(storage,"bk",resource,filename,true);
                if(path==null||path.isEmpty())throw new IOException("voice_storage_path");
                if(paths.add(path))try(RandomAccessFile output=(RandomAccessFile)XposedHelpers.callStaticMethod(vfs,"B",path,true)){
                    output.setLength(0);output.write(data);output.getFD().sync();
                }
            }
            Class<?> paramsType=Class.forName("fj0.d",true,loader);
            Object params=paramsType.getConstructor(String.class,String.class).newInstance(group,filename);
            nativeParams[0]=params;
            XposedHelpers.setIntField(params,"h",duration);XposedHelpers.setIntField(params,"i",0);
            Object sendTask=Class.forName("nj0.x",true,loader).getConstructor(paramsType).newInstance(params);
            Object service=registry.getMethod("c",Class.class).invoke(null,Class.forName("gj0.f",true,loader));
            if(!authorized.contains(group))throw new SecurityException("group_not_authorized");
            invoked.set(true);
            XposedHelpers.callMethod(service,"Mj",sendTask);
            return true;
        });
        main.post(task);
        try{
            task.get(10,TimeUnit.SECONDS);
            long deadline=System.currentTimeMillis()+55000;
            while(System.currentTimeMillis()<deadline){
                for(Object database:databases.values()){
                    // Match our unique native filename, never merely the newest voice in this group.
                    try(Cursor cursor=query(database,"SELECT msgId,status,msgSvrId FROM message WHERE imgPath=? AND talker=? AND isSend=1 AND type=34 LIMIT 1",filename,group)){
                        if(cursor.moveToFirst()){
                            result.put("local_id",cursor.getLong(0)).put("wechat_status",cursor.getInt(1)).put("has_server_id",cursor.getLong(2)>0);
                            if(cursor.getInt(1)==2&&cursor.getLong(2)>0)return result.put("state","sent").put("reason","wechat_server_ack");
                            if(cursor.getInt(1)==5){
                                voiceDiagnostics(result,nativeParams[0]);
                                return result.put("state","failed").put("reason","wechat_voice_failed");
                            }
                        }
                    }catch(Throwable ignored){}
                }
                Thread.sleep(250);
            }
        }catch(Throwable error){
            task.cancel(false);result.put("reason","voice_send_exception_"+error.getClass().getSimpleName());
            if(error instanceof ExecutionException&&!invoked.get())result.put("state","failed").put("reason","voice_preflight_failed");
            Log.w("NilaWeChatHook","voice_send_failed",error);
        }
        voiceDiagnostics(result,nativeParams[0]);
        return result;
    }
    private void voiceDiagnostics(JSONObject result,Object params){
        if(params==null)return;
        // Numeric stage/error codes only. Never expose CDN URLs, keys or message data.
        try{
            for(String stage:new String[]{"q","r","s","t"}){
                Object value=XposedHelpers.getObjectField(params,stage);
                if(value!=null){
                    result.put("stage_"+stage,XposedHelpers.getIntField(value,"a"));
                    if(stage.equals("s")){result.put("network_error_type",XposedHelpers.getIntField(value,"c"));result.put("network_error_code",XposedHelpers.getIntField(value,"d"));}
                }
            }
        }catch(Throwable ignored){}
    }

    private JSONObject sendImage(JSONObject request) throws Exception {
        String group=request.getString("chat_id"),id=request.getString("id"),mime=request.getString("mime_type");
        if(!id.matches("[a-f0-9\\-]{36}")||!Arrays.asList("image/jpeg","image/png","image/webp").contains(mime))throw new IllegalArgumentException("invalid_image_request");
        refreshGroups();if(!groups.containsKey(group)||!authorized.contains(group))throw new SecurityException("group_not_authorized");
        String encoded=request.getString("data");if(encoded.length()>11184812)throw new IllegalArgumentException("image_size");
        byte[] data=Base64.decode(encoded,Base64.DEFAULT);
        if(data.length<16||data.length>8*1024*1024)throw new IllegalArgumentException("image_size");
        BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(data,0,data.length,bounds);
        if(bounds.outWidth<1||bounds.outHeight<1||bounds.outWidth>4096||bounds.outHeight>4096||!mime.equals(bounds.outMimeType))throw new IllegalArgumentException("invalid_image");
        StringBuilder hex=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))hex.append(String.format(Locale.ROOT,"%02x",b&255));
        String hash=hex.toString();
        if(imageStore.contains(id)){
            JSONObject previous=new JSONObject(imageStore.getString(id,"{}"));
            if(!group.equals(previous.optString("chat_id"))||!hash.equals(previous.optString("sha256")))throw new IllegalArgumentException("idempotency_conflict");
            return previous;
        }
        File file=new File(imageDirectory,id+(mime.equals("image/jpeg")?".jpg":mime.equals("image/png")?".png":".webp"));
        try(FileOutputStream output=new FileOutputStream(file)){output.write(data);output.getFD().sync();}
        JSONObject result=new JSONObject().put("state","uncertain").put("reason","image_send_reserved")
            .put("chat_id",group).put("sha256",hash).put("created_at",System.currentTimeMillis());
        if(!imageStore.edit().putString(id,result.toString()).commit())throw new IOException("image_reservation_failed");
        final java.util.concurrent.atomic.AtomicLong messageId=new java.util.concurrent.atomic.AtomicLong();
        final Object[] serviceAndListener=new Object[2];
        FutureTask<Boolean> task=new FutureTask<>(()->{
            Class<?> registry=Class.forName("ni5.n0",true,loader),serviceType=Class.forName("kt.d1",true,loader);
            Object service=registry.getMethod("c",Class.class).invoke(null,serviceType);
            serviceAndListener[0]=service;
            Class<?> listenerType=Class.forName("la0.b",true,loader);
            Object listener=java.lang.reflect.Proxy.newProxyInstance(loader,new Class[]{listenerType},(proxy,method,args)->{
                if(method.getName().equals("hashCode"))return System.identityHashCode(proxy);
                if(method.getName().equals("equals"))return proxy==args[0];
                if(method.getName().equals("toString"))return "NilaImageDelivery";
                if(method.getName().equals("Re")&&args!=null&&args.length==1){
                    try{
                        Object parameters=XposedHelpers.getObjectField(args[0],"a");
                        if(file.getAbsolutePath().equals(XposedHelpers.getObjectField(parameters,"a"))&&group.equals(XposedHelpers.getObjectField(parameters,"d"))){
                            long local=XposedHelpers.getLongField(args[0],"c");if(local>0)messageId.set(local);
                        }
                    }catch(Throwable ignored){}
                }
                return null;
            });
            serviceAndListener[1]=listener;XposedHelpers.callMethod(service,"Gj",listener);
            Class<?> crossType=Class.forName("ea0.i0",true,loader);
            Object cross=crossType.getDeclaredConstructor().newInstance();XposedHelpers.setIntField(cross,"a",3);
            String from=(String)XposedHelpers.callStaticMethod(Class.forName("l41.y1",true,loader),"u");
            if(from==null||from.isEmpty())throw new IllegalStateException("wechat_not_logged_in");
            Object parameters=Class.forName("la0.g",true,loader).getConstructor(String.class,int.class,String.class,String.class,crossType)
                .newInstance(file.getAbsolutePath(),0,from,group,cross);
            XposedHelpers.callMethod(service,"Oj",parameters);
            return true;
        });
        main.post(task);
        try{
            task.get(8,TimeUnit.SECONDS);result.put("reason","no_server_ack_yet");
            long deadline=System.currentTimeMillis()+55000;
            while(System.currentTimeMillis()<deadline){
                long local=messageId.get();
                if(local>0)for(Object database:databases.values()){
                    try(Cursor cursor=query(database,"SELECT status,msgSvrId FROM message WHERE msgId=? AND talker=? AND isSend=1 AND type=3 LIMIT 1",local,group)){
                        if(cursor.moveToFirst()){
                            result.put("local_id",local).put("wechat_status",cursor.getInt(0)).put("has_server_id",cursor.getLong(1)>0);
                            if(cursor.getInt(0)==2&&cursor.getLong(1)>0){result.put("state","sent").put("reason","wechat_server_ack");return result;}
                            if(cursor.getInt(0)==5){result.put("state","failed").put("reason","wechat_image_failed");return result;}
                        }
                    }catch(Throwable ignored){}
                }
                Thread.sleep(250);
            }
        }catch(Throwable error){task.cancel(false);result.put("reason","image_send_exception_"+error.getClass().getSimpleName());}
        finally{
            main.post(()->{try{if(serviceAndListener[0]!=null&&serviceAndListener[1]!=null)XposedHelpers.callMethod(serviceAndListener[0],"Nj",serviceAndListener[1]);}catch(Throwable ignored){}});
            imageStore.edit().putString(id,result.toString()).commit();
            if(result.optString("state").equals("sent"))file.delete();
        }
        return result;
    }

    private void serve(ServerSocket server) {
        while(!server.isClosed()) {
            try(Socket socket=server.accept()) {
                socket.setSoTimeout(5000);
                BufferedInputStream input=new BufferedInputStream(socket.getInputStream());
                String first=readLine(input,2048); String[] request=first.split(" ");
                if(request.length!=3) throw new IOException("request");
                String authorization=""; int length=0,headerBytes=first.length();
                for(;;) {
                    String line=readLine(input,2048);headerBytes+=line.length();if(headerBytes>8192)throw new IOException("headers");
                    if(line.isEmpty())break;
                    int colon=line.indexOf(':');if(colon<=0)throw new IOException("header");
                    String key=line.substring(0,colon).toLowerCase(Locale.ROOT), val=line.substring(colon+1).trim();
                    if(key.equals("authorization"))authorization=val;
                    if(key.equals("content-length"))length=Integer.parseInt(val);
                    if(key.equals("transfer-encoding"))throw new IOException("transfer_encoding");
                }
                if(!MessageDigest.isEqual(("Bearer "+token).getBytes(StandardCharsets.UTF_8),authorization.getBytes(StandardCharsets.UTF_8))) {
                    respond(socket,401,new JSONObject().put("error","unauthorized"));continue;
                }
                int bodyLimit=request[1].equals("/send/image")?12*1024*1024:request[1].equals("/send/voice")?2*1024*1024:16384;
                if(length<0||length>bodyLimit)throw new IOException("body_limit");
                byte[] bytes=new byte[length]; int count=0;
                while(count<length){int n=input.read(bytes,count,length-count);if(n<0)throw new EOFException();count+=n;}
                URI uri=new URI(request[1]); JSONObject result;
                if(request[0].equals("GET")&&uri.getPath().equals("/status")) {
                    result=new JSONObject().put("connected",true).put("mode","android_hook").put("generation",generation)
                        .put("api_version",12).put("voice_supported",true).put("voice_receipts","persistent").put("bot_name","Gemini").put("quoted_reply_supported",true).put("group_image_read_supported",true).put("group_image_member_supported",true).put("group_image_download_supported",true).put("private_links_supported",true).put("private_pairing_supported",true).put("group_history_supported",true).put("text_receipts","persistent").put("identity_supported",true).put("image_supported",true).put("signup_supported",true).put("database_handles",databases.size()).put("authorized_groups",authorized.size()).put("events",sequence);
                } else if(request[0].equals("POST")&&uri.getPath().equals("/private/pairing")) {
                    result=pairPrivate(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/private/authorization")) {
                    result=authorizePrivate(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/private/history")) {
                    result=privateHistory(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/private/send")) {
                    result=sendPrivate(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/identity/resolve")) {
                    result=resolveIdentity(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("GET")&&uri.getPath().equals("/groups")) {
                    result=new JSONObject().put("groups",refreshGroups()).put("generation",generation).put("signup_supported",true);
                } else if(request[0].equals("GET")&&uri.getPath().equals("/signup/requests")) {
                    result=new JSONObject().put("requests",signupRequests());
                } else if(request[0].equals("POST")&&uri.getPath().equals("/signup/ack")) {
                    result=acknowledgeSignup(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/authorization")) {
                    result=authorize(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("GET")&&uri.getPath().equals("/history")) {
                    result=history(uri);
                } else if(request[0].equals("GET")&&uri.getPath().equals("/events")) {
                    String query=uri.getQuery(); long after=query!=null&&query.matches("after=[0-9]+")?Long.parseLong(query.substring(6)):0;
                    JSONArray batch=new JSONArray();long oldest,cursor;
                    synchronized(events){cursor=sequence;oldest=events.isEmpty()?cursor+1:events.get(0).getLong("seq");for(JSONObject event:events)if(event.getLong("seq")>after)batch.put(event);}
                    result=new JSONObject().put("generation",generation).put("cursor",cursor).put("oldest",oldest).put("events",batch);
                } else if(request[0].equals("POST")&&uri.getPath().equals("/send")) {
                    result=send(new JSONObject(new String(bytes,StandardCharsets.UTF_8)),false);
                } else if(request[0].equals("POST")&&uri.getPath().equals("/send/voice")) {
                    result=sendVoice(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/send/image")) {
                    result=sendImage(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/replies/lookup")) {
                    JSONObject body=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
                    result=new JSONObject().put("messages",recentReplies(body.getString("chat_id"),body.getLong("since"),body.optString("message_id",null)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/images/latest")) {
                    result=latestImage(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else if(request[0].equals("POST")&&uri.getPath().equals("/delivery")) {
                    result=delivery(new JSONObject(new String(bytes,StandardCharsets.UTF_8)));
                } else {respond(socket,404,new JSONObject().put("error","not_found"));continue;}
                respond(socket,200,result);
            } catch(Throwable error) {
                Log.w("NilaWeChatHook","local_request_failed:"+error.getClass().getSimpleName());
            }
        }
    }
    private static String readLine(InputStream input,int max) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        for(int i=0;i<max;i++){int b=input.read();if(b<0)throw new EOFException();if(b=='\n')return new String(out.toByteArray(),StandardCharsets.US_ASCII).replace("\r","");out.write(b);}
        throw new IOException("line_limit");
    }
    private static String readSmall(InputStream input,int max) throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] block=new byte[1024];int n;
        while((n=input.read(block))>=0){if(out.size()+n>max)throw new IOException("limit");out.write(block,0,n);}
        return new String(out.toByteArray(),StandardCharsets.UTF_8);
    }
    private static void respond(Socket socket,int code,JSONObject value) throws IOException {
        byte[] body=value.toString().getBytes(StandardCharsets.UTF_8);
        OutputStream out=socket.getOutputStream();
        out.write(("HTTP/1.1 "+code+" Result\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "+body.length+"\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body);out.flush();
    }
}
