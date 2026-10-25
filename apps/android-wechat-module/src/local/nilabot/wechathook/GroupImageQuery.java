package local.nilabot.wechathook;

/** Exact sender prefix (not LIKE), anchored before the requesting text message. */
public final class GroupImageQuery {
    private GroupImageQuery() {}
    public static final String LATEST = "SELECT * FROM message WHERE talker=? AND type=3 AND isSend=0 AND (createTime<? OR (createTime=? AND msgId<?)) AND substr(content,1,?)=? ORDER BY createTime DESC,msgId DESC LIMIT 1";
}
