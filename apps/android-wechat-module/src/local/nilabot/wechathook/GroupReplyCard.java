package local.nilabot.wechathook;

import java.io.StringReader;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

/** Parse only the direct fields of a type-57 quote; XML never proves bot identity. */
public final class GroupReplyCard {
    public final String text, serverId;
    private GroupReplyCard(String text,String serverId){this.text=text;this.serverId=serverId;}
    public static GroupReplyCard parse(String xml){
        if(xml==null||xml.length()>100000||xml.contains("<!DOCTYPE")||xml.contains("<!ENTITY"))return null;
        try{
            XmlPullParser p=XmlPullParserFactory.newInstance().newPullParser();p.setInput(new StringReader(xml));
            String type=null,title=null,id=null;int app=-1,ref=-1;boolean seenRef=false;
            for(int event=p.next();event!=XmlPullParser.END_DOCUMENT;event=p.next()){
                if(event==XmlPullParser.START_TAG){
                    String name=p.getName();int depth=p.getDepth();
                    if(name.equals("appmsg")&&app==-1&&(depth==1||depth==2)){app=depth;}
                    else if(app>0&&depth==app+1){
                        if(name.equals("type")){if(type!=null)return null;type=p.nextText();}
                        else if(name.equals("title")){if(title!=null)return null;title=p.nextText();}
                        else if(name.equals("refermsg")){if(seenRef)return null;seenRef=true;ref=depth;}
                    }else if(ref>0&&depth==ref+1&&name.equals("svrid")){if(id!=null)return null;id=p.nextText();}
                }else if(event==XmlPullParser.END_TAG){
                    if(p.getName().equals("refermsg")&&p.getDepth()==ref)ref=-1;
                    if(p.getName().equals("appmsg")&&p.getDepth()==app)break;
                }
            }
            if(!"57".equals(type)||title==null||title.trim().isEmpty()||title.length()>8000||id==null||!id.matches("[1-9][0-9]{0,18}")||Long.parseLong(id)<=0)return null;
            return new GroupReplyCard(title.trim(),id);
        }catch(Exception ignored){return null;}
    }
}
