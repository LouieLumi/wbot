package local.nilabot.wechathook;

import java.util.regex.Pattern;

/** Gemini is the current name; Nila remains a migration alias. */
final class BotMentions {
    private static final Pattern MENTION=Pattern.compile("(^|[\\s\\u2005])@(?:Gemini|Nila)(?=[\\s\\u2005]|$)",Pattern.CASE_INSENSITIVE);
    private static final Pattern SIGNUP=Pattern.compile("(?:@(?:Gemini|Nila)[\\s\\u2005]+)?/signup",Pattern.CASE_INSENSITIVE);
    static boolean contains(String text){return text!=null&&MENTION.matcher(text).find();}
    static boolean signup(String text){return text!=null&&SIGNUP.matcher(text.trim()).matches();}
}
