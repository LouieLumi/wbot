package local.nilabot.wechathook;

public final class PrivateLinkCardTest {
    private static void equal(String expected,String actual){
        if(expected==null?actual!=null:!expected.equals(actual))throw new AssertionError("Unexpected parsed link");
    }
    public static void main(String[] args){
        equal("https://example.com/a?x=1&y=2",PrivateLinkCard.extract("<msg><appmsg><title>Title</title><type>5</type><url><![CDATA[https://example.com/a?x=1&y=2]]></url></appmsg></msg>"));
        equal("https://example.com/a?x=1&y=2",PrivateLinkCard.extract("<msg><appmsg><type>5</type><url>https://example.com/a?x=1&amp;y=2</url></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("<msg><appmsg><type>6</type><url>https://example.com/file</url></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("<msg><appmsg><type>5</type><url>file:///etc/passwd</url></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///etc/passwd'>]><msg><appmsg><type>5</type><url>&a;</url></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("<msg><appmsg><type>5</type><nested><url>https://example.com/fake</url></nested></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("<msg><appmsg><url>https://example.com/no-type</url></appmsg></msg>"));
        equal(null,PrivateLinkCard.extract("not xml"));
        System.out.println("Private share-card parsing: 8 checks passed.");
    }
}
