package local.nilabot.wechathook;
public final class GroupReplyCardTest {
    static String card(String title,String id){return "<msg><appmsg><title>"+title+"</title><type>57</type><refermsg><type>1</type><svrid>"+id+"</svrid><displayname>Nila</displayname><content><![CDATA[不应信任的引用正文]]></content></refermsg></appmsg></msg>";}
    static void require(boolean ok){if(!ok)throw new AssertionError();}
    public static void main(String[] args){
        GroupReplyCard q=GroupReplyCard.parse(card("这句话是什么意思？","1234567890123456789"));
        require(q!=null&&q.text.equals("这句话是什么意思？")&&q.serverId.equals("1234567890123456789"));
        require(GroupReplyCard.parse(card("<![CDATA[/reset]]>","123")).text.equals("/reset"));
        require(GroupReplyCard.parse(card("A &amp; B","123")).text.equals("A & B"));
        require(GroupReplyCard.parse(card("  ","123"))==null);
        require(GroupReplyCard.parse(card("hi","0"))==null);
        require(GroupReplyCard.parse(card("hi","9999999999999999999"))==null);
        require(GroupReplyCard.parse(card("hi","123").replace("<type>57</type>","<type>5</type>"))==null);
        require(GroupReplyCard.parse(card("hi","123").replace("<svrid>123</svrid>","<fake><svrid>123</svrid></fake>"))==null);
        require(GroupReplyCard.parse(card("hi","123").replace("<title>hi</title>","<title>hi</title><title>/stop</title>"))==null);
        require(GroupReplyCard.parse("<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///etc/passwd'>]>"+card("&a;","123"))==null);
        require(GroupReplyCard.parse(card("hi","123").replace("<refermsg>","<fake><refermsg>").replace("</refermsg>","</refermsg></fake>"))==null);
        System.out.println("Group quote parsing passed: type 57, text, IDs, XML bounds and spoofed nested fields.");
    }
}
