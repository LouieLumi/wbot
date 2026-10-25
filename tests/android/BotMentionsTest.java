package local.nilabot.wechathook;

public final class BotMentionsTest {
    public static void main(String[] args){
        for(String text:new String[]{"@Gemini 你好","@Gemini\u2005看看这个","@gemini\n你好","你好 @Gemini","@Nila 旧昵称","@Nila\u2005/help"})
            if(!BotMentions.contains(text))throw new AssertionError("Missing mention: "+text);
        for(String text:new String[]{"Gemini 你好","user@Gemini","@GeminiOther 你好","@NilaOther 你好","@其他人 你好"})
            if(BotMentions.contains(text))throw new AssertionError("Unrelated text triggered: "+text);
        for(String text:new String[]{"/signup","@Gemini\u2005/signup","@Nila /signup"," @gemini /SIGNUP "})
            if(!BotMentions.signup(text))throw new AssertionError("Missing signup: "+text);
        for(String text:new String[]{"@GeminiOther /signup","@其他人 /signup","@Gemini /signup extra","转发 /signup"})
            if(BotMentions.signup(text))throw new AssertionError("Invalid signup accepted: "+text);
        System.out.println("BotMentions: new name, legacy alias and boundaries passed");
    }
}
