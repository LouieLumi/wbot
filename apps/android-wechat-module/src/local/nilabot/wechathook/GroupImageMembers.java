package local.nilabot.wechathook;

import java.text.Normalizer;
import java.util.*;

/** Resolve only members supplied by this room's authoritative roster. */
public final class GroupImageMembers {
    public static final class Member {
        public final String id, name;
        public final List<String> labels;
        public Member(String id, String... labels) {
            this.id=id;this.labels=Arrays.asList(labels);
            String display=id;
            for(String label:labels)if(label!=null&&!label.trim().isEmpty()){display=label;break;}
            this.name=display;
        }
    }
    public static String normalized(String value) {
        if(value==null)return "";
        String text=Normalizer.normalize(value,Normalizer.Form.NFKC).trim();
        return text.startsWith("@")?text.substring(1).trim():text;
    }
    public static boolean self(String value) {
        return Arrays.asList("","self","我","自己").contains(normalized(value));
    }
    public static List<Member> resolve(List<Member> roster,String selector,String requester,Set<String> mentions) {
        String wanted=normalized(selector);List<Member> matches=new ArrayList<>();
        if(self(selector))wanted=requester;
        for(Member member:roster)if(member.id.equals(wanted))return Collections.singletonList(member);
        for(Member member:roster)for(String label:member.labels){
            if(!wanted.isEmpty()&&wanted.equals(normalized(label))){matches.add(member);break;}
        }
        if(matches.size()>1){
            List<Member> mentioned=new ArrayList<>();
            for(Member member:matches)if(mentions.contains(member.id))mentioned.add(member);
            if(mentioned.size()==1)return mentioned;
        }
        return matches;
    }
}
