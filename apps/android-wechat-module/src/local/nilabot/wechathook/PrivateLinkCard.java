package local.nilabot.wechathook;

import java.io.StringReader;
import java.net.URI;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

/** Parse a normal type-5 share card without entities, fetching or following links. */
final class PrivateLinkCard {
    static String extract(String xml) {
        if(xml==null||xml.length()>100000||xml.contains("<!DOCTYPE")||xml.contains("<!ENTITY"))return null;
        try {
            XmlPullParser parser=XmlPullParserFactory.newInstance().newPullParser();
            parser.setInput(new StringReader(xml));
            String type=null,url=null;int appDepth=-1;
            for(int event=parser.next();event!=XmlPullParser.END_DOCUMENT;event=parser.next()){
                if(event==XmlPullParser.START_TAG){
                    if(parser.getName().equals("appmsg")&&appDepth==-1)appDepth=parser.getDepth();
                    else if(appDepth>0&&parser.getDepth()==appDepth+1){
                        if(parser.getName().equals("type"))type=parser.nextText();
                        else if(parser.getName().equals("url"))url=parser.nextText();
                    }
                }else if(event==XmlPullParser.END_TAG&&parser.getName().equals("appmsg"))break;
            }
            if(!"5".equals(type)||url==null||url.length()>4096)return null;
            URI uri=new URI(url.trim());
            return ("https".equalsIgnoreCase(uri.getScheme())||"http".equalsIgnoreCase(uri.getScheme()))&&uri.getHost()!=null?url.trim():null;
        }catch(Exception ignored){return null;}
    }
}
